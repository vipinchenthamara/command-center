// Granola meeting notes.
//
// Two routes, in order of preference:
//   1. The official MCP server (OAuth). Preferred: supported, and keeps working unattended.
//   2. A folder of exported notes, if you would rather not link an account.
//
// The local Granola app database is deliberately NOT read. granola.db is encrypted at
// rest (SQLCipher-style, with the key sealed by Windows DPAPI in storage.dek), and the
// surrounding files are a Chromium cache plus telemetry. Reading it would mean defeating
// the vendor's own encryption and would break on any update.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { db, hash, newId, nowISO, getSource, updateSource } from "../db.mjs";
import { granolaAuthState, listMeetings, getMeetings, getAccountInfo,
         getMeetingTranscript } from "./granola-mcp.mjs";
import { granolaApiState, listNotes, getNote, getTranscript, renderTranscript } from "./granola-api.mjs";

const SKIP_DIR = /^(Cache|Code Cache|GPUCache|sentry|telemetry|logs|Partitions|Local Storage|Session Storage|IndexedDB|blob_storage|DawnCache|Crashpad|NativeMessagingHosts)$/i;

function walk(dir, out, depth) {
  out = out || []; depth = depth || 0;
  if (depth > 4) return out;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name) || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), out, depth + 1);
    } else if ([".md", ".json", ".txt"].includes(extname(e.name).toLowerCase())) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const insert = () => db.prepare(
  "INSERT INTO raw_items(id,source,source_id,hash,payload,occurred_at,collected_at,processed) VALUES (?,?,?,?,?,?,?,0) " +
  "ON CONFLICT(source,source_id) DO UPDATE SET hash=excluded.hash,payload=excluded.payload," +
  "collected_at=excluded.collected_at," +
  "processed=CASE WHEN raw_items.hash=excluded.hash THEN raw_items.processed ELSE 0 END");

export async function collectGranola(cfg) {
  const c = cfg.granola || {};

  // Preference order: API key (no sign-in, survives reboots) > MCP OAuth > export folder.
  if (granolaApiState().configured) return collectViaApi(cfg);
  if (granolaAuthState().linked) return collectViaMcp(cfg, granolaAuthState());
  if (c.enabled && c.cachePath && existsSync(c.cachePath)) return collectViaFolder(cfg, c);

  updateSource("granola", {
    enabled: 0, last_status: "not_configured", coverage_complete: 0,
    last_error: "Not connected. Run: node cc.mjs granola-key <grn_...>  (or granola-login, or set granola.cachePath).",
    scope_note: "No meeting coverage. Briefings state this rather than implying there were no meetings.",
  });
  return { ok: false, skipped: true, reason: "not_configured" };
}

// ---------- route 0: public API with a static key (preferred) ----------
async function collectViaApi(cfg) {
  updateSource("granola", { enabled: 1, last_attempt_at: nowISO() });
  const src = getSource("granola");
  const g = cfg.granola || {};
  const overlapMs = (cfg.overlapHours || 12) * 3600000;
  const since = src && src.checkpoint
    ? new Date(new Date(src.checkpoint).getTime() - overlapMs)
    : new Date(Date.now() - (cfg.lookbackDays || 3) * 86400000);

  // Transcripts only pay off when something can read conversational speech properly.
  // With rules-based extraction they mostly add disfluent near-misses, while Granola's
  // own summary is already clean, so default to transcripts only when AI extraction is on.
  const aiOn = !!(cfg.ai && cfg.ai.enabled && cfg.ai.apiKey);
  const wantTranscripts = g.includeTranscripts === true
    || (g.includeTranscripts !== false && aiOn);
  const tCap = g.transcriptChars || 12000;
  const meName = (cfg.identity && cfg.identity.name) || "Me";

  try {
    const notes = await listNotes(since.toISOString(), g.maxMeetings || 50);
    const collectedAt = nowISO();
    const ins = insert();
    let stored = 0, withTranscript = 0, newest = new Date(0), partial = false;

    for (const n of notes) {
      let detail;
      try { detail = await getNote(n.id); }
      catch (e) { if (e.auth) throw e; partial = true; continue; }

      const when = new Date(detail.created_at || n.created_at || collectedAt);
      const summary = detail.summary_markdown || detail.summary_text || "";
      const mine = detail.private_notes_markdown || detail.private_notes_text || "";

      let transcriptText = "";
      if (wantTranscripts) {
        try {
          const segs = await getTranscript(n.id);
          if (segs.length) {
            withTranscript++;
            transcriptText = renderTranscript(segs, meName).slice(0, tCap);
          }
        } catch (e) { if (e.auth) throw e; partial = true; }
      }

      const body = [
        summary && "## Summary\n" + summary,
        mine && "## My notes\n" + mine,
        transcriptText && "## Transcript\n" + transcriptText,
      ].filter(Boolean).join("\n\n");
      if (!body.trim()) continue;

      const attendees = (detail.attendees || []).map((a) => a.name || a.email).filter(Boolean);
      const payload = {
        sourceId: "granola:" + n.id,
        title: detail.title || n.title || "Untitled meeting",
        body,
        meetingAt: when.toISOString(),
        attendees,
        url: detail.web_url || "",
        meLabel: meName,
      };
      ins.run(newId(), "granola", payload.sourceId, hash(body + "|" + payload.title),
        JSON.stringify(payload), payload.meetingAt, collectedAt);
      stored++;
      if (when > newest) newest = when;
    }

    updateSource("granola", {
      enabled: 1, last_attempt_at: collectedAt, last_success_at: collectedAt,
      last_status: partial ? "partial" : "ok",
      // Never advance the checkpoint past coverage we could not verify.
      checkpoint: !partial && stored && newest > new Date(0)
        ? newest.toISOString() : (src && src.checkpoint) || null,
      scope_note: "Public API - " + notes.length + " note(s) changed since " +
        since.toISOString().slice(0, 10) + ", " + stored + " stored, " + withTranscript + " with transcript",
      items_seen: stored,
      coverage_complete: partial ? 0 : 1,
      last_error: partial ? "Some notes or transcripts could not be read this run." : "",
    });
    return { ok: true, items: stored, listed: notes.length, complete: !partial };
  } catch (e) {
    updateSource("granola", {
      enabled: 1, last_attempt_at: nowISO(),
      last_status: e.auth ? "auth_required" : "error",
      last_error: e.message, coverage_complete: 0,
    });
    return { ok: false, error: e.message, auth: !!e.auth };
  }
}

// ---------- route 1: official MCP ----------
async function collectViaMcp(cfg, auth) {
  updateSource("granola", { enabled: 1, last_attempt_at: nowISO() });
  const src = getSource("granola");
  const overlapMs = (cfg.overlapHours || 12) * 3600000;
  const since = src && src.checkpoint
    ? new Date(new Date(src.checkpoint).getTime() - overlapMs)
    : new Date(Date.now() - (cfg.lookbackDays || 3) * 86400000);

  try {
    let account = "";
    try {
      const info = await getAccountInfo();
      account = info.email || info.account || (info.user && info.user.email) || "";
    } catch { /* non-fatal: account info is a nicety */ }

    const { meetings } = await listMeetings(since.toISOString(), cfg.granola?.maxMeetings || 50);

    // Fill in note bodies for anything the list call returned without content.
    const needBodies = meetings.filter((m) => !m.notes).map((m) => m.id);
    if (needBodies.length) {
      try {
        const full = await getMeetings(needBodies.slice(0, 25));
        const byId = new Map(full.meetings.map((m) => [m.id, m]));
        for (const m of meetings) {
          const f = byId.get(m.id);
          if (f && f.notes) m.notes = f.notes;
        }
      } catch { /* keep whatever the list gave us */ }
    }

    const collectedAt = nowISO();
    const ins = insert();
    let stored = 0, newest = new Date(0), transcripts = 0;

    // Transcripts are a paid-plan tool. They catch commitments the summary smoothed over,
    // but they are long, so they are appended after the notes and capped.
    const wantTranscripts = cfg.granola?.includeTranscripts !== false;
    const tCap = cfg.granola?.transcriptChars || 12000;

    for (const m of meetings) {
      const when = m.when ? new Date(m.when) : null;
      if (when && when < since) continue;

      let body = String(m.notes || "").trim();
      if (wantTranscripts) {
        try {
          const t = await getMeetingTranscript(m.id);
          if (t && t.trim()) {
            transcripts++;
            body += (body ? "\n\n--- Transcript ---\n" : "") + t.trim().slice(0, tCap);
          }
        } catch (e) { if (e.auth) throw e; }
      }
      if (!body) continue;   // nothing to extract from yet

      const payload = {
        sourceId: "granola:" + m.id,
        title: m.title,
        body: body.slice(0, 8000 + tCap),
        meetingAt: when ? when.toISOString() : collectedAt,
        attendees: m.attendees,
        url: m.url || "",
      };
      ins.run(newId(), "granola", payload.sourceId, hash(payload.body + "|" + payload.title),
        JSON.stringify(payload), payload.meetingAt, collectedAt);
      stored++;
      if (when && when > newest) newest = when;
    }

    const withNotes = meetings.filter((m) => m.notes && String(m.notes).trim()).length;
    const complete = true;
    updateSource("granola", {
      enabled: 1, last_attempt_at: collectedAt, last_success_at: collectedAt, last_status: "ok",
      checkpoint: stored && newest > new Date(0) ? newest.toISOString() : (src && src.checkpoint) || null,
      scope_note: "MCP" + (account ? " as " + account : "") + " - " + meetings.length +
        " meeting(s), " + withNotes + " with notes, " + transcripts + " with transcript",
      items_seen: stored, coverage_complete: complete ? 1 : 0, last_error: "",
    });
    return { ok: true, items: stored, listed: meetings.length, complete };
  } catch (e) {
    updateSource("granola", {
      enabled: 1, last_attempt_at: nowISO(),
      last_status: e.auth ? "auth_required" : "error",
      last_error: e.auth ? "Granola sign-in needed. Run: node cc.mjs granola-login" : e.message,
      coverage_complete: 0,
    });
    return { ok: false, error: e.message, auth: !!e.auth };
  }
}

// ---------- route 2: exported notes folder ----------
async function collectViaFolder(cfg, c) {
  updateSource("granola", { enabled: 1, last_attempt_at: nowISO() });
  try {
    const src = getSource("granola");
    const overlapMs = (cfg.overlapHours || 12) * 3600000;
    const since = src && src.checkpoint
      ? new Date(new Date(src.checkpoint).getTime() - overlapMs)
      : new Date(Date.now() - (cfg.lookbackDays || 3) * 86400000);

    const files = walk(c.cachePath);
    const collectedAt = nowISO();
    const ins = insert();
    let count = 0, newest = new Date(0);

    for (const f of files) {
      let st; try { st = statSync(f); } catch { continue; }
      if (st.mtime < since) continue;
      let text = ""; try { text = readFileSync(f, "utf8"); } catch { continue; }
      if (!text.trim()) continue;
      if (extname(f).toLowerCase() === ".json") {
        try {
          const j = JSON.parse(text);
          text = j.notes || j.summary || j.transcript || j.content || JSON.stringify(j);
        } catch { /* fall back to raw text */ }
      }
      const payload = {
        sourceId: f, title: basename(f).replace(/\.[^.]+$/, ""),
        body: String(text).slice(0, 8000), meetingAt: st.mtime.toISOString(), path: f,
      };
      ins.run(newId(), "granola", f, hash(payload.body), JSON.stringify(payload), payload.meetingAt, collectedAt);
      count++;
      if (st.mtime > newest) newest = st.mtime;
    }

    updateSource("granola", {
      enabled: 1, last_attempt_at: collectedAt, last_success_at: collectedAt, last_status: "ok",
      checkpoint: count ? newest.toISOString() : (src && src.checkpoint) || null,
      scope_note: "Export folder: " + c.cachePath + " (" + files.length + " file(s) scanned)",
      items_seen: count, coverage_complete: 1, last_error: "",
    });
    return { ok: true, items: count, complete: true };
  } catch (e) {
    updateSource("granola", { enabled: 1, last_attempt_at: nowISO(), last_status: "error",
      last_error: e.message, coverage_complete: 0 });
    return { ok: false, error: e.message };
  }
}
