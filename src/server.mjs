// Local HTTP service. Bound to loopback, mutations gated by a per-process token
// and an Origin/Host check so another site cannot drive it (PRD s13).
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, db, nowISO } from "./db.mjs";
import { loadConfig, saveConfig } from "./config.mjs";
import { runCollection, coverageReport, isRunning } from "./pipeline.mjs";
import { buildBriefingData, saveBriefing, localDate, scoreRecord } from "./brief.mjs";
import { buildCockpit } from "./cockpit.mjs";
import { applyUserEdit, createManual } from "./reconcile.mjs";
import { exportVault } from "./vault.mjs";

const TOKEN = randomBytes(24).toString("hex");
const WEB = join(ROOT, "src", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

const send = (res, code, body, type = "application/json; charset=utf-8") => {
  const payload = type.startsWith("application/json") ? JSON.stringify(body) : body;
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    "Referrer-Policy": "no-referrer",
  });
  res.end(payload);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 1e6) { req.destroy(); reject(new Error("body too large")); } });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}

function guard(req) {
  // Only same-origin loopback callers may mutate.
  const host = req.headers.host || "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return "bad host";
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return "bad origin";
  if ((req.headers["x-cc-token"] || "") !== TOKEN) return "bad token";
  return null;
}

function recordDetail(id) {
  const r = db.prepare("SELECT * FROM records WHERE id=?").get(id);
  if (!r) return null;
  r.evidence = db.prepare("SELECT quote,context,source_url,observed_at FROM evidence WHERE record_id=?").all(id);
  r.provenance = db.prepare("SELECT source,source_id,first_seen,last_seen FROM provenance WHERE record_id=?").all(id);
  r.user_edited = JSON.parse(r.user_edited || "{}");
  return r;
}

function fullState(cfg) {
  const today = localDate(cfg);
  const brief = buildBriefingData(cfg);
  const all = db.prepare("SELECT * FROM records WHERE dismissed=0 ORDER BY updated_at DESC").all()
    .map((r) => ({ ...r, ...scoreRecord(r, today) }));
  const lastRun = db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get();
  return {
    today,
    now: nowISO(),
    timezone: cfg.timezone,
    identity: cfg.identity,
    running: isRunning(),
    brief,
    coverage: coverageReport(),
    records: all,
    lastRun: lastRun ? { ...lastRun, summary: JSON.parse(lastRun.summary || "{}") } : null,
    aiEnabled: !!(cfg.ai && cfg.ai.enabled && cfg.ai.apiKey),
  };
}

export function startServer(cfg) {
  const port = (cfg.server && cfg.server.port) || 7777;
  const host = (cfg.server && cfg.server.host) || "127.0.0.1";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://" + (req.headers.host || "127.0.0.1"));
    const p = url.pathname;

    try {
      // ---- static ----
      if (req.method === "GET" && !p.startsWith("/api/")) {
        const rel = p === "/" ? "/index.html" : p;
        const file = normalize(join(WEB, rel)).replace(/^(\.\.[\\/])+/, "");
        if (!file.startsWith(WEB) || !existsSync(file)) return send(res, 404, { error: "not found" });
        let body = readFileSync(file, "utf8");
        // Every page needs the per-process token, not just the index.
        if (extname(file) === ".html") body = body.replace("__CC_TOKEN__", TOKEN);
        return send(res, 200, body, MIME[extname(file)] || "text/plain");
      }

      // ---- read APIs ----
      if (req.method === "GET" && p === "/api/state") return send(res, 200, fullState(loadConfig()));

      if (req.method === "GET" && p === "/api/cockpit") {
        const cfg2 = loadConfig();
        return send(res, 200, { ...buildCockpit(cfg2), running: isRunning() });
      }

      if (req.method === "GET" && p === "/api/record") {
        const r = recordDetail(url.searchParams.get("id"));
        return r ? send(res, 200, r) : send(res, 404, { error: "not found" });
      }

      if (req.method === "GET" && p === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return send(res, 200, { results: [] });
        let rows;
        try {
          rows = db.prepare(`SELECT r.* FROM records_fts f JOIN records r ON r.rowid=f.rowid
            WHERE records_fts MATCH ? AND r.dismissed=0 ORDER BY rank LIMIT 40`).all(q + "*");
        } catch {
          rows = db.prepare("SELECT * FROM records WHERE dismissed=0 AND title LIKE ? LIMIT 40").all("%" + q + "%");
        }
        return send(res, 200, { results: rows });
      }

      if (req.method === "GET" && p === "/api/briefing") {
        const cfg2 = loadConfig();
        const row = db.prepare("SELECT * FROM briefings WHERE date=?").get(localDate(cfg2));
        return send(res, 200, row || { body: "", degraded: 0, generated_at: null });
      }

      if (req.method === "GET" && p === "/api/config") {
        const c = loadConfig();
        // Never return secrets to the page.
        return send(res, 200, {
          ...c,
          ai: { ...c.ai, apiKey: c.ai.apiKey ? "***set***" : "" },
          monday: { ...c.monday, apiToken: c.monday.apiToken ? "***set***" : "" },
        });
      }

      // ---- mutations ----
      if (req.method === "POST") {
        const bad = guard(req);
        if (bad) return send(res, 403, { error: bad });
        const body = await readBody(req);

        if (p === "/api/refresh") {
          const cfg2 = loadConfig();
          const joined = isRunning();
          runCollection(cfg2, "manual")
            .then(() => { const b = saveBriefing(cfg2); if (cfg2.vault && cfg2.vault.enabled) exportVault(cfg2, b.body); })
            .catch((e) => console.error("run failed:", e.message));
          return send(res, 202, { started: true, joinedExistingRun: joined });
        }

        if (p === "/api/record/update") {
          try {
            const updated = applyUserEdit(body.id, body.patch || {}, body.revision);
            return send(res, 200, updated);
          } catch (e) {
            return send(res, e.code === 409 ? 409 : e.code === 404 ? 404 : 400, { error: e.message });
          }
        }

        if (p === "/api/record/create") {
          if (!body.title || !String(body.title).trim()) return send(res, 400, { error: "Title is required" });
          return send(res, 200, createManual(body));
        }

        if (p === "/api/briefing/regenerate") {
          const cfg2 = loadConfig();
          const b = saveBriefing(cfg2);
          if (cfg2.vault && cfg2.vault.enabled) exportVault(cfg2, b.body);
          return send(res, 200, { ok: true, date: b.data.date });
        }

        if (p === "/api/config") {
          const patch = { ...body };
          // Empty string means "leave unchanged", so a masked field never wipes a real secret.
          if (patch.ai && (patch.ai.apiKey === "" || patch.ai.apiKey === "***set***")) delete patch.ai.apiKey;
          if (patch.monday && (patch.monday.apiToken === "" || patch.monday.apiToken === "***set***")) delete patch.monday.apiToken;
          const c = saveConfig(patch);
          return send(res, 200, { ok: true, timezone: c.timezone });
        }

        return send(res, 404, { error: "unknown endpoint" });
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      console.error("request error:", e);
      return send(res, 500, { error: e.message });
    }
  });

  server.listen(port, host, () => {
    const url = "http://" + host + ":" + port + "/";
    console.log("");
    console.log("  Command Center is running.");
    console.log("  " + url);
    console.log("");
    console.log("  Bound to loopback only. Mutations require a per-process token.");
    console.log("  Stop with Ctrl+C.");
    console.log("");
  });
  return server;
}
