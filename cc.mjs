#!/usr/bin/env node
// Command Center CLI. Same pipeline for scheduled and manual runs.
import { ensureConfig, loadConfig, CONFIG_PATH } from "./src/config.mjs";
import { runCollection, coverageReport } from "./src/pipeline.mjs";
import { saveBriefing } from "./src/brief.mjs";
import { exportVault } from "./src/vault.mjs";
import { startServer } from "./src/server.mjs";
import { db } from "./src/db.mjs";

const cmd = process.argv[2] || "serve";
const cfg = ensureConfig();

function printCoverage() {
  console.log("\n  Source coverage");
  console.log("  " + "-".repeat(72));
  for (const c of coverageReport()) {
    const state = !c.enabled ? "not configured"
      : c.status === "ok" && c.complete ? "ok"
      : c.status + (c.complete ? "" : " / partial");
    console.log("  " + c.name.padEnd(10) + state.padEnd(18) +
      (c.lastSuccess ? "last ok " + c.lastSuccess.slice(0, 16).replace("T", " ") : "never succeeded"));
    if (c.error) console.log("             " + c.error.slice(0, 100));
  }
  console.log("");
}

if (cmd === "collect" || cmd === "run") {
  const r = await runCollection(cfg, process.argv[3] === "--scheduled" ? "scheduled" : "manual",
    (m) => console.log("  " + m));
  const b = saveBriefing(cfg);
  if (cfg.vault && cfg.vault.enabled) {
    const v = exportVault(cfg, b.body);
    console.log("  Vault export: " + v.written + " note(s) -> " + v.root);
  }
  printCoverage();
  if (r.degraded) {
    console.log("  NOTE: collection was incomplete. The briefing states which sources were not fully covered.");
    process.exitCode = 2;   // lets Task Scheduler surface a degraded run
  }
} else if (cmd === "setup") {
  // First-run check for a fresh clone: what is wired up, what is still missing.
  const { CONNECTORS } = await import("./src/connectors/index.mjs");
  const c = loadConfig();
  console.log("\n  Command Center — setup check\n  " + "-".repeat(60));

  const id = c.identity || {};
  const idOk = !!(id.email && id.name);
  console.log("  identity        " + (idOk ? "ok  " + id.name + " <" + id.email + ">"
    : "MISSING — set identity.email and identity.name in " + CONFIG_PATH));
  console.log("  timezone        " + c.timezone);
  console.log("");

  for (const conn of CONNECTORS) {
    let state = "not configured";
    if (conn.name === "outlook" || conn.name === "calendar") {
      state = process.platform === "win32"
        ? "ready (needs classic Outlook desktop installed and running)"
        : "UNAVAILABLE — Outlook COM is Windows-only";
    } else if (conn.name === "granola") {
      const { granolaApiState } = await import("./src/connectors/granola-api.mjs");
      state = granolaApiState().configured
        ? "ready (API key from " + granolaApiState().source + ")"
        : "needs: node cc.mjs granola-key grn_...";
    } else if (conn.name === "monday") {
      state = c.monday && c.monday.apiToken ? "ready" : "needs: set MONDAY_API_TOKEN";
    } else if (conn.name === "teams") {
      state = "not implemented by design — see README";
    }
    console.log("  " + conn.name.padEnd(16) + state);
  }

  const aiOn = !!(c.ai && c.ai.apiKey);
  console.log("\n  ai extraction   " + (aiOn ? "ready (" + c.ai.model + ")"
    : "optional — set ANTHROPIC_API_KEY to improve extraction; rules run without it"));
  console.log("\n  Next: node cc.mjs collect   then   node cc.mjs serve\n");
} else if (cmd === "granola-key") {
  const key = process.argv[3];
  if (!key || !key.startsWith("grn_")) {
    console.log("\n  Usage: node cc.mjs granola-key grn_xxxxx\n");
    process.exit(1);
  }
  const { saveApiKey } = await import("./src/connectors/granola-api.mjs");
  saveApiKey(key);
  console.log("\n  Stored in data/granola-auth.json (owner-only). Now run: node cc.mjs granola-test\n");
} else if (cmd === "granola-login") {
  const { granolaLogin } = await import("./src/connectors/granola-mcp.mjs");
  await granolaLogin((m) => console.log(m));
  console.log("\n  Now run: node cc.mjs granola-test\n");
} else if (cmd === "granola-test") {
  const { granolaApiState, listNotes, getNote, getTranscript, renderTranscript } =
    await import("./src/connectors/granola-api.mjs");
  const st = granolaApiState();
  console.log("\n  API key: " + (st.configured ? "configured (from " + st.source + ")" : "MISSING"));
  if (!st.configured) { console.log("  Run: node cc.mjs granola-key grn_xxxxx\n"); process.exit(1); }

  const days = Number(process.argv[3] || 30);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const notes = await listNotes(since, 25);
  console.log("  Notes updated in the last " + days + " days: " + notes.length + "\n");

  let shown = 0;
  for (const n of notes) {
    if (shown >= 8) break;
    const d = await getNote(n.id);
    const summary = d.summary_markdown || d.summary_text || "";
    const mine = d.private_notes_markdown || d.private_notes_text || "";
    const segs = await getTranscript(n.id, 400);
    const meLines = segs.filter((s) => s.speaker && s.speaker.attribution === "me").length;
    console.log("    " + String(d.created_at || "").slice(0, 16).replace("T", " ") +
      "  " + String(d.title || "Untitled").slice(0, 46));
    console.log("       summary=" + summary.length + "ch  myNotes=" + mine.length +
      "ch  transcript=" + segs.length + " segs (" + meLines + " yours)  attendees=" +
      (d.attendees || []).length);
    shown++;
  }
  console.log("");
} else if (cmd === "brief") {
  const b = saveBriefing(cfg);
  console.log("\n" + b.body + "\n");
} else if (cmd === "status") {
  printCoverage();
  const counts = db.prepare(`SELECT type, COUNT(*) c FROM records WHERE dismissed=0
    AND status NOT IN ('done','cancelled') GROUP BY type`).all();
  console.log("  Open records: " + (counts.map((x) => x.type + "=" + x.c).join(", ") || "none"));
  console.log("  Config: " + CONFIG_PATH + "\n");
} else if (cmd === "serve") {
  startServer(loadConfig());
} else {
  console.log(`
  Command Center

    node cc.mjs serve      Start the dashboard (default)
    node cc.mjs collect    Run one collection + briefing now
    node cc.mjs brief      Rebuild and print today's briefing
    node cc.mjs status     Show source coverage and open counts

    node cc.mjs granola-key K   Store your Granola API key (grn_...)
    node cc.mjs granola-test    Verify Granola access and list recent meetings
    node cc.mjs granola-login   Alternative: browser OAuth instead of an API key

  Config: ${CONFIG_PATH}
`);
}
