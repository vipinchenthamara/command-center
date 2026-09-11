// One run = collect -> extract -> reconcile. Single writer by construction:
// a second request joins the in-flight run instead of starting a competing one (PRD A16).
import { db, newId, nowISO, getSource, updateSource } from "./db.mjs";
import { CONNECTORS } from "./connectors/index.mjs";
import { extractFromEmail, extractFromMonday, extractFromGranola } from "./extract/rules.mjs";
import { upsertCandidate } from "./reconcile.mjs";

let inFlight = null;

// Generic coverage bookkeeping for connectors that return a plain result object.
// `complete: false` is preserved faithfully — a source that saw only part of its data
// must never be recorded as fully covered.
function recordResult(c, r) {
  if (r && r.skipped) {
    updateSource(c.name, {
      enabled: 0, last_attempt_at: nowISO(), last_status: r.reason || "not_configured",
      last_error: r.error || "", coverage_complete: 0,
    });
    return;
  }
  const ok = !!(r && r.ok);
  const complete = ok && r.complete !== false;
  updateSource(c.name, {
    enabled: 1,
    last_attempt_at: nowISO(),
    last_success_at: ok ? nowISO() : (getSource(c.name) || {}).last_success_at,
    last_status: ok ? (complete ? "ok" : "partial") : (r && r.auth ? "auth_required" : "error"),
    last_error: ok ? (complete ? "" : r.error || "Partial coverage this run.") : (r && r.error) || "unknown",
    scope_note: (r && r.scope) || (ok ? (r.items || 0) + " item(s) collected — " + c.label : ""),
    items_seen: (r && r.items) || 0,
    coverage_complete: complete ? 1 : 0,
  });
}

export function isRunning() { return inFlight !== null; }

// Deliberately not `async`: an async wrapper would return a fresh promise per call,
// hiding the fact that both callers are joined to the same underlying run.
export function runCollection(cfg, trigger = "manual", onLog = () => {}) {
  if (inFlight) { onLog("A run is already active; joining it."); return inFlight; }
  inFlight = (async () => {
    const runId = newId();
    const started = nowISO();
    db.prepare("INSERT INTO runs(id,started_at,trigger,status) VALUES (?,?,?,'running')").run(runId, started, trigger);

    const summary = { sources: {}, created: 0, updated: 0, unchanged: 0, skipped: 0, extracted_by: "rules" };
    try {
      // --- Collect. One source failing must not abort the others (PRD s12). ---
      for (const c of CONNECTORS) {
        onLog("Collecting " + c.name + "...");
        try {
          const r = await c.collect(cfg);
          summary.sources[c.name] = r;
          // Connectors that do not write their own source row get the generic
          // bookkeeping here, so a new one only has to return a result object.
          if (!c.selfReports) recordResult(c, r);
        } catch (e) {
          summary.sources[c.name] = { ok: false, error: e.message };
          updateSource(c.name, {
            last_attempt_at: nowISO(), last_status: "error",
            last_error: e.message, coverage_complete: 0,
          });
        }
      }

      // --- Extract only what actually changed. ---
      const pending = db.prepare("SELECT * FROM raw_items WHERE processed=0 ORDER BY occurred_at DESC LIMIT 500").all();
      onLog("Extracting from " + pending.length + " new or changed item(s)...");

      let aiMap = null;
      if (cfg.ai && cfg.ai.enabled && cfg.ai.apiKey && pending.length) {
        try {
          const { extractWithAI } = await import("./extract/ai.mjs");
          const subset = pending.slice(0, cfg.ai.maxItemsPerRun || 120);
          aiMap = await extractWithAI(subset, cfg);
          summary.extracted_by = "ai";
          onLog("AI extraction returned findings for " + aiMap.size + " item(s).");
        } catch (e) {
          onLog("AI extraction unavailable (" + e.message + "). Falling back to rules.");
          summary.ai_error = e.message;
          aiMap = null;
        }
      }

      const markDone = db.prepare("UPDATE raw_items SET processed=1 WHERE id=?");
      for (const row of pending) {
        let payload;
        try { payload = JSON.parse(row.payload); } catch { markDone.run(row.id); continue; }

        let cands;
        if (aiMap && aiMap.has(row.id)) {
          cands = aiMap.get(row.id);
        } else if (row.source === "outlook") {
          cands = extractFromEmail(payload, cfg);
        } else if (row.source === "monday") {
          cands = extractFromMonday(payload);
        } else if (row.source === "granola") {
          cands = extractFromGranola(payload);
        } else {
          cands = [];
        }

        for (const c of cands) {
          const r = upsertCandidate(row.source, row.source_id, c, {
            extractedBy: aiMap && aiMap.has(row.id) ? "ai" : "rules",
            collectedAt: row.collected_at,
            sourceModifiedAt: payload.modifiedAt || null,
            sourceCreatedAt: payload.createdAt || payload.receivedAt || null,
          });
          if (r.action === "created") summary.created++;
          else if (r.action === "updated") summary.updated++;
          else if (r.action === "unchanged") summary.unchanged++;
          else summary.skipped++;
        }
        markDone.run(row.id);
      }

      // A run is only "ok" if every enabled source actually reported complete coverage.
      const srcRows = db.prepare("SELECT name,enabled,last_status,coverage_complete FROM sources").all();
      const degraded = srcRows.some((s) => s.enabled === 1 && (s.last_status !== "ok" || s.coverage_complete !== 1));
      summary.degraded = degraded;

      db.prepare("UPDATE runs SET finished_at=?, status=?, summary=? WHERE id=?")
        .run(nowISO(), degraded ? "partial" : "ok", JSON.stringify(summary), runId);

      onLog("Run finished: " + summary.created + " new, " + summary.updated + " enriched, " + summary.unchanged + " unchanged.");
      return { runId, ...summary };
    } catch (e) {
      db.prepare("UPDATE runs SET finished_at=?, status='error', summary=? WHERE id=?")
        .run(nowISO(), JSON.stringify({ error: e.message }), runId);
      throw e;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function coverageReport() {
  const rows = db.prepare("SELECT * FROM sources ORDER BY name").all();
  return rows.map((s) => ({
    name: s.name,
    enabled: !!s.enabled,
    status: s.last_status,
    complete: !!s.coverage_complete,
    lastSuccess: s.last_success_at,
    lastAttempt: s.last_attempt_at,
    error: s.last_error,
    scope: s.scope_note,
    items: s.items_seen,
    checkpoint: s.checkpoint,
  }));
}
