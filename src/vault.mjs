// Obsidian vault export. One-way: SQLite is the authority, the vault is a rendering.
// Regenerated each run, so it is always safe to delete and rebuild (PRD A22).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.mjs";
import { localDate } from "./brief.mjs";

const safe = (s) => String(s || "untitled").replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 90);

function frontMatter(o) {
  const L = ["---"];
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === "") continue;
    L.push(k + ": " + (typeof v === "string" && /[:#]/.test(v) ? JSON.stringify(v) : v));
  }
  L.push("---");
  return L.join("\n");
}

export function exportVault(cfg, briefingBody) {
  const root = (cfg.vault && cfg.vault.path) || join(process.cwd(), "vault");
  const dirs = {
    tasks: join(root, "Tasks"),
    issues: join(root, "Issues"),
    meetings: join(root, "Meetings"),
    discussions: join(root, "Discussions"),
    daily: join(root, "Daily"),
    system: join(root, "System"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

  const records = db.prepare("SELECT * FROM records WHERE dismissed=0 ORDER BY updated_at DESC").all();
  const evStmt = db.prepare("SELECT quote, context, source_url FROM evidence WHERE record_id=? LIMIT 5");
  let written = 0;

  for (const r of records) {
    const dir = r.type === "issue" ? dirs.issues
      : r.type === "decision" || r.type === "discussion" ? dirs.discussions
      : r.type === "clarification" ? dirs.tasks
      : dirs.tasks;

    const ev = evStmt.all(r.id);
    const body = [
      frontMatter({
        id: r.id, type: r.type, status: r.status, priority: r.priority,
        project: r.project, owner: r.owner, source: r.source,
        source_due_date: r.source_due_date, planned_date: r.planned_date,
        defer_until: r.defer_until, external_issue_id: r.external_issue_id,
        confidence: r.confidence, extracted_by: r.extracted_by, revision: r.revision,
        created_at: r.created_at, updated_at: r.updated_at,
      }),
      "",
      "# " + r.title,
      "",
      r.detail ? "> " + r.detail : "",
      "",
      r.needs_clarification ? "**Needs clarification:** " + (r.clarification_note || "ownership unclear") + "\n" : "",
      "## Evidence",
      ev.length ? ev.map((e) => "- " + JSON.stringify(e.quote) + (e.context ? "\n  - " + e.context : "")).join("\n")
        : "_No stored evidence._",
      "",
      "---",
      "_Rendered from the Command Center database. Edits here are not read back._",
    ].join("\n");

    writeFileSync(join(dir, safe(r.title) + " - " + r.id.slice(0, 8) + ".md"), body, "utf8");
    written++;
  }

  if (briefingBody) {
    writeFileSync(join(dirs.daily, localDate(cfg) + ".md"), briefingBody, "utf8");
  }

  const coverage = db.prepare("SELECT * FROM sources ORDER BY name").all();
  writeFileSync(join(dirs.system, "Coverage.md"), [
    frontMatter({ generated: new Date().toISOString() }),
    "",
    "# Source coverage",
    "",
    "| Source | Enabled | Status | Complete | Last success | Items |",
    "| --- | --- | --- | --- | --- | --- |",
    ...coverage.map((c) => "| " + [c.name, c.enabled ? "yes" : "no", c.last_status,
      c.coverage_complete ? "yes" : "no", c.last_success_at || "never", c.items_seen].join(" | ") + " |"),
  ].join("\n"), "utf8");

  return { written, root };
}
