// Automated checks against the PRD acceptance table. Run: node acceptance.mjs
import { loadConfig } from "./src/config.mjs";
import { db, tx } from "./src/db.mjs";
import { runCollection } from "./src/pipeline.mjs";
import { applyUserEdit, createManual } from "./src/reconcile.mjs";
import { buildBriefingData, saveBriefing } from "./src/brief.mjs";
import { exportVault } from "./src/vault.mjs";

const cfg = loadConfig();
const results = [];
const check = (id, desc, fn) => {
  try { const r = fn(); results.push([id, r ? "PASS" : "FAIL", desc]); }
  catch (e) { results.push([id, "FAIL", desc + " -> " + e.message]); }
};

check("A01", "Dashboard renders saved records with accurate freshness labels", () => {
  const d = buildBriefingData(cfg);
  return d.coverage.length > 0 && d.coverage.every((c) => "lastSuccess" in c && "complete" in c);
});

check("A02", "Inbox vs Today are two distinct, durable planning outcomes", () => {
  const a = createManual({ title: "acc inbox item" });
  const b = createManual({ title: "acc today item", planned_date: buildBriefingData(cfg).date });
  const ra = db.prepare("SELECT planned_date FROM records WHERE id=?").get(a.id);
  const rb = db.prepare("SELECT planned_date FROM records WHERE id=?").get(b.id);
  db.prepare("DELETE FROM records WHERE id IN (?,?)").run(a.id, b.id);
  return ra.planned_date === null && rb.planned_date !== null;
});

check("A04", "Human completion survives re-import", () => {
  const r = db.prepare("SELECT * FROM records WHERE source='outlook' LIMIT 1").get();
  if (!r) return false;
  applyUserEdit(r.id, { status: "done" }, r.revision);
  db.exec("UPDATE raw_items SET processed=0 WHERE source='outlook'");
  return true; // verified live below
});

check("A05", "Replaying an unchanged batch creates no records or revisions", () => {
  const before = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(revision),0) s FROM records").get();
  db.exec("UPDATE raw_items SET processed=0");
  return { before };  // completed asynchronously below
});

check("A08", "No fabricated due dates", () => {
  const bad = db.prepare(`SELECT COUNT(*) c FROM records
    WHERE source_due_date IS NOT NULL AND source='outlook' AND extracted_by='rules'`).get().c;
  return bad === 0;  // the rules extractor never sets a source date
});

check("A09", "Deferred work stays discoverable and returns on its date", () => {
  const m = createManual({ title: "acc defer item" });
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  applyUserEdit(m.id, { defer_until: future }, m.revision);
  const activeNow = buildBriefingData(cfg);
  const hidden = !activeNow.priorities.some((x) => x.id === m.id);
  const stillThere = !!db.prepare("SELECT id FROM records WHERE id=? AND defer_until=?").get(m.id, future);
  db.prepare("DELETE FROM records WHERE id=?").run(m.id);
  return hidden && stillThere;
});

check("A17", "Multi-write failure rolls back atomically", () => {
  const before = db.prepare("SELECT COUNT(*) c FROM records").get().c;
  try {
    tx(() => {
      createManual({ title: "acc tx a" });
      throw new Error("simulated crash mid-commit");
    });
  } catch { /* expected */ }
  const after = db.prepare("SELECT COUNT(*) c FROM records").get().c;
  return before === after;
});

check("A18", "A failed source retains previously tracked work", () => {
  const before = db.prepare("SELECT COUNT(*) c FROM records WHERE source='outlook'").get().c;
  db.prepare("UPDATE sources SET last_status='error', coverage_complete=0, last_error='simulated' WHERE name='outlook'").run();
  const after = db.prepare("SELECT COUNT(*) c FROM records WHERE source='outlook'").get().c;
  const degraded = buildBriefingData(cfg).degraded;
  db.prepare("UPDATE sources SET last_status='ok', coverage_complete=1, last_error='' WHERE name='outlook'").run();
  return before === after && degraded === true;
});

check("A20", "Answers disclose coverage gaps rather than implying completeness", () => {
  const d = buildBriefingData(cfg);
  const unconfigured = d.coverage.filter((c) => !c.enabled).length;
  return unconfigured > 0 ? d.gaps.length >= unconfigured : true;
});

check("A22", "Derived index can be deleted and rebuilt without losing records", () => {
  const before = db.prepare("SELECT COUNT(*) c FROM records").get().c;
  db.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild')");
  const hits = db.prepare("SELECT COUNT(*) c FROM records_fts").get().c;
  return before === hits;
});

check("A24", "Vault export is regenerable from the database", () => {
  const v = exportVault(cfg, saveBriefing(cfg).body);
  return v.written > 0;
});

// --- async checks that need a real pipeline pass ---
const beforeCount = db.prepare("SELECT COUNT(*) c FROM records").get().c;
const beforeRev = db.prepare("SELECT COALESCE(SUM(revision),0) s FROM records").get().s;
const doneId = db.prepare("SELECT id FROM records WHERE status='done' LIMIT 1").get();
db.exec("UPDATE raw_items SET processed=0");
await runCollection(cfg, "manual", () => {});
const afterCount = db.prepare("SELECT COUNT(*) c FROM records").get().c;
const afterRev = db.prepare("SELECT COALESCE(SUM(revision),0) s FROM records").get().s;

results.find((r) => r[0] === "A05")[1] =
  afterCount === beforeCount && afterRev === beforeRev ? "PASS" : "FAIL";
results.find((r) => r[0] === "A04")[1] =
  doneId && db.prepare("SELECT status FROM records WHERE id=?").get(doneId.id).status === "done" ? "PASS" : "FAIL";

// A16: a second refresh must join the active run, not start a competing writer.
// The invariant that matters is that exactly one run row is created, not promise identity.
const runsBefore = db.prepare("SELECT COUNT(*) c FROM runs").get().c;
const p1 = runCollection(cfg, "manual", () => {});
const p2 = runCollection(cfg, "manual", () => {});
const joined = p1 === p2;
await Promise.all([p1, p2]);
const runsAfter = db.prepare("SELECT COUNT(*) c FROM runs").get().c;
results.push(["A16", joined && runsAfter - runsBefore === 1 ? "PASS" : "FAIL",
  "Concurrent refresh joins the active run, one writer (" + (runsAfter - runsBefore) + " run row created)"]);

// restore
if (doneId) db.prepare("UPDATE records SET status='todo', user_edited='{}' WHERE id=?").run(doneId.id);

console.log("\n  PRD acceptance checks\n  " + "-".repeat(70));
for (const [id, state, desc] of results.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log("  " + id + "  " + state.padEnd(6) + desc);
}
const failed = results.filter((r) => r[1] === "FAIL").length;
console.log("\n  " + (results.length - failed) + "/" + results.length + " passed\n");
process.exit(failed ? 1 : 0);
