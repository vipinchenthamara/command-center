// Briefing generation. Priority reasons are computed deterministically so every
// suggestion can explain itself, and coverage gaps are stated rather than hidden.
import { db, nowISO } from "./db.mjs";
import { coverageReport } from "./pipeline.mjs";

export function localDate(cfg, d = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: cfg.timezone || "Asia/Kuala_Lumpur",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

// Returns {score, reasons[]} -- reasons are shown in the UI, never invented.
export function scoreRecord(rec, today) {
  let score = 0;
  const reasons = [];

  if (rec.source_due_date) {
    if (rec.source_due_date < today) { score += 50; reasons.push("Source deadline passed (" + rec.source_due_date + ")"); }
    else if (rec.source_due_date === today) { score += 40; reasons.push("Due today per source"); }
    else { score += 12; reasons.push("Source deadline " + rec.source_due_date); }
  }
  if (rec.planned_date) {
    if (rec.planned_date < today) { score += 30; reasons.push("You planned this for " + rec.planned_date); }
    else if (rec.planned_date === today) { score += 45; reasons.push("You planned this for today"); }
  }
  if (rec.type === "issue") { score += 20; reasons.push("Tracked as an issue or blocker"); }
  // Your own work outranks passive items; waiting is a reminder, not an action.
  if (rec.type === "task") { score += 10; }
  if (rec.type === "waiting") { score -= 4; reasons.push("Waiting on someone else"); }
  if (rec.priority <= 2) { score += 18; reasons.push("Marked high priority"); }
  if (rec.status === "in_progress") { score += 15; reasons.push("Already in progress"); }

  const ageDays = Math.floor((Date.now() - new Date(rec.created_at).getTime()) / 86400000);
  if (ageDays >= 7) { score += Math.min(15, ageDays); reasons.push("Open for " + ageDays + " days"); }

  score += Math.round((rec.confidence || 0.5) * 6);
  if (rec.needs_clarification) { score -= 20; reasons.push("Ownership or scope is unclear"); }

  // Always give the user something concrete to judge the suggestion by, rather
  // than a bare "open item" that explains nothing.
  if (!reasons.length) {
    const src = rec.source === "manual" ? "captured by you" : "from " + rec.source;
    const age = Math.floor((Date.now() - new Date(rec.created_at).getTime()) / 86400000);
    reasons.push(src + (age <= 0 ? ", seen today" : ", seen " + age + "d ago") +
      (rec.detail ? " — " + String(rec.detail).slice(0, 70) : ""));
  }

  return { score, reasons };
}

// Highest-scoring items, but capped per type so one noisy category cannot fill the
// whole list. A briefing showing six issues and no tasks answers the wrong question.
function diversify(sorted, limit, perType) {
  const out = [];
  const used = {};
  for (const r of sorted) {
    if (out.length >= limit) break;
    used[r.type] = used[r.type] || 0;
    if (used[r.type] >= perType) continue;
    used[r.type]++;
    out.push(r);
  }
  // Backfill from whatever is left if the caps left us short.
  for (const r of sorted) {
    if (out.length >= limit) break;
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

export function activeRecords() {
  return db.prepare(`SELECT * FROM records
    WHERE dismissed=0 AND status NOT IN ('done','cancelled')
      AND (defer_until IS NULL OR defer_until <= date('now'))`).all();
}

export function buildBriefingData(cfg) {
  const today = localDate(cfg);
  const all = activeRecords();
  const scored = all.map((r) => ({ ...r, ...scoreRecord(r, today) }))
    .sort((a, b) => b.score - a.score);

  const coverage = coverageReport();
  const degraded = coverage.some((c) => c.enabled && (c.status !== "ok" || !c.complete));
  const gaps = coverage.filter((c) => !c.enabled || c.status !== "ok" || !c.complete);

  const yesterdayISO = new Date(Date.now() - 86400000).toISOString();
  return {
    date: today,
    generatedAt: nowISO(),
    degraded,
    coverage,
    gaps,
    priorities: diversify(scored.filter((r) => !r.needs_clarification && r.type !== "discussion"), 6, 3),
    newItems: scored.filter((r) => r.created_at >= yesterdayISO),
    issues: scored.filter((r) => r.type === "issue"),
    waiting: scored.filter((r) => r.type === "waiting"),
    decisions: db.prepare(`SELECT * FROM records WHERE type='decision' AND dismissed=0
      ORDER BY created_at DESC LIMIT 8`).all(),
    clarifications: scored.filter((r) => r.needs_clarification),
    counts: {
      open: all.length,
      today: all.filter((r) => r.planned_date === today).length,
      overdue: all.filter((r) => r.source_due_date && r.source_due_date < today).length,
      issues: all.filter((r) => r.type === "issue").length,
      waiting: all.filter((r) => r.type === "waiting").length,
      needsClarification: all.filter((r) => r.needs_clarification).length,
    },
  };
}

function line(r) {
  const bits = [];
  if (r.source_due_date) bits.push("due " + r.source_due_date);
  if (r.planned_date) bits.push("planned " + r.planned_date);
  bits.push(r.source);
  return "- " + r.title + "  _(" + bits.join(", ") + ")_";
}

export function renderBriefingMarkdown(data) {
  const L = [];
  L.push("# Briefing - " + data.date);
  L.push("");
  L.push("_Generated " + data.generatedAt + "_");
  L.push("");

  if (data.degraded) {
    L.push("> **Collection was incomplete.** This briefing does not cover every source.");
    for (const g of data.gaps) {
      L.push("> - **" + g.name + "**: " + (g.enabled ? g.status : "not configured") +
        (g.error ? " - " + g.error : ""));
    }
    L.push("");
  } else {
    L.push("_All enabled sources reported complete coverage._");
    L.push("");
  }

  L.push("## Suggested priorities");
  if (!data.priorities.length) L.push("_Nothing outstanding._");
  for (const r of data.priorities) {
    L.push("- **" + r.title + "**");
    L.push("  - Why: " + (r.reasons.length ? r.reasons.join("; ") : "Open item"));
  }
  L.push("");

  const section = (title, rows, empty) => {
    L.push("## " + title);
    if (!rows.length) L.push("_" + empty + "_");
    else for (const r of rows.slice(0, 12)) L.push(line(r));
    L.push("");
  };

  section("New since yesterday", data.newItems, "Nothing new.");
  section("Issues and blockers", data.issues, "No tracked issues.");
  section("Waiting on others", data.waiting, "Nothing outstanding from others.");

  L.push("## Decisions recorded");
  if (!data.decisions.length) L.push("_None recorded._");
  else for (const r of data.decisions) L.push("- " + r.title);
  L.push("");

  L.push("## Needs clarification");
  if (!data.clarifications.length) L.push("_Nothing ambiguous._");
  else for (const r of data.clarifications) {
    L.push("- " + r.title + (r.clarification_note ? "  _(" + r.clarification_note + ")_" : ""));
  }
  L.push("");

  L.push("## Coverage");
  for (const c of data.coverage) {
    const state = !c.enabled ? "not configured"
      : c.status === "ok" && c.complete ? "ok"
      : c.status + (c.complete ? "" : ", partial coverage");
    L.push("- **" + c.name + "**: " + state +
      (c.lastSuccess ? " - last success " + c.lastSuccess : " - never succeeded") +
      (c.scope ? " - " + c.scope : ""));
  }
  return L.join("\n");
}

export function saveBriefing(cfg) {
  const data = buildBriefingData(cfg);
  const body = renderBriefingMarkdown(data);
  db.prepare(`INSERT INTO briefings(date,generated_at,body,coverage,degraded) VALUES (?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET generated_at=excluded.generated_at, body=excluded.body,
      coverage=excluded.coverage, degraded=excluded.degraded`)
    .run(data.date, data.generatedAt, body, JSON.stringify(data.coverage), data.degraded ? 1 : 0);
  return { data, body };
}
