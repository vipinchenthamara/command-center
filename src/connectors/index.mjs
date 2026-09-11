// Connector registry.
//
// To plug in a new productivity tool, write one file in this folder that exports a
// `collect(cfg)` function, then add one entry to the CONNECTORS array below. The
// pipeline will run it, record its coverage, and the dashboard will show it — no other
// file needs to change.
//
// ── The contract ──────────────────────────────────────────────────────────────
// collect(cfg) must resolve to a result object:
//
//   { ok: true,  items: <number stored>, complete: <bool>, scope: "<human summary>" }
//   { ok: false, error: "<what went wrong>", auth: true }   // auth:true => needs sign-in
//   { ok: false, skipped: true, reason: "not_configured" }  // nothing set up yet
//
// `complete` is the honesty flag: pass false when you know you did NOT see everything
// (a page limit, a rate limit, a partial load). It is what stops a briefing claiming
// full coverage it never had.
//
// Store what you collect as rows in `raw_items` (see any existing connector):
//   source, source_id, hash(payload), payload JSON, occurred_at
// The hash makes re-collection replay-safe — an unchanged item is never re-extracted.
//
// Then teach the extractor what your payload looks like, in src/extract/rules.mjs
// (and optionally src/extract/ai.mjs), and add a case in src/pipeline.mjs where
// candidates are built.
// ──────────────────────────────────────────────────────────────────────────────

import { registerSource } from "../db.mjs";
import { collectOutlook } from "./outlook.mjs";
import { collectCalendar } from "./calendar.mjs";
import { collectGranola } from "./granola.mjs";
import { collectMonday } from "./monday.mjs";
import { collectTeams } from "./teams.mjs";

export const CONNECTORS = [
  {
    name: "outlook",
    label: "Outlook mail",
    collect: collectOutlook,
    // This connector writes its own richer source row (account, folder counts),
    // so the pipeline should not overwrite it with the generic summary.
    selfReports: true,
  },
  {
    name: "calendar",
    label: "Outlook calendar",
    collect: collectCalendar,
    selfReports: false,
  },
  {
    name: "granola",
    label: "Granola meetings",
    collect: collectGranola,
    selfReports: true,
  },
  {
    name: "monday",
    label: "monday.com issues",
    collect: collectMonday,
    selfReports: true,
  },
  {
    name: "teams",
    label: "Microsoft Teams",
    collect: collectTeams,
    selfReports: true,
  },
];

// Every registered connector gets a coverage row, so a newly added tool shows up in
// the dashboard immediately as "not configured" rather than being silently absent.
for (const c of CONNECTORS) registerSource(c.name);

export const connectorNames = () => CONNECTORS.map((c) => c.name);
export const connectorLabel = (name) =>
  (CONNECTORS.find((c) => c.name === name) || {}).label || name;
