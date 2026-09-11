// Reconciliation. Enforces stable identity, field ownership, and status preservation.
//
// Identity is anchored on (source item, type, verbatim evidence quote) -- never on the
// title, which the user may rename and which an AI pass may word differently. Because
// unchanged raw items are never re-extracted, a stable source yields a stable key.
import { db, hash, newId, nowISO, tx } from "./db.mjs";

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim().slice(0, 160);

export function candidateKey(sourceItemId, cand) {
  const anchor = cand.evidence && cand.evidence[0] && cand.evidence[0].quote
    ? norm(cand.evidence[0].quote)
    : norm(cand.title);
  return hash(sourceItemId + "|" + cand.type + "|" + anchor);
}

function userOwns(rec, field) {
  try { return Object.prototype.hasOwnProperty.call(JSON.parse(rec.user_edited || "{}"), field); }
  catch { return false; }
}

// Fields an import may set. Anything the user has touched is left alone (PRD s11).
const IMPORT_FIELDS = ["title", "detail", "project", "owner", "source_due_date", "source_url", "confidence"];

export function upsertCandidate(sourceName, sourceItemId, cand, meta) {
  const key = candidateKey(sourceItemId, cand);
  const sourceId = sourceName + ":" + key;
  const now = nowISO();

  const existing = db.prepare("SELECT * FROM records WHERE source=? AND source_id=?").get(sourceName, sourceId);

  if (!existing) {
    // A previously dismissed record must not be recreated by the same unchanged evidence.
    const tomb = db.prepare("SELECT id FROM records WHERE source=? AND source_id=? AND dismissed=1").get(sourceName, sourceId);
    if (tomb) return { action: "skipped_dismissed", id: tomb.id };

    const id = newId();
    db.prepare(`INSERT INTO records
      (id,type,title,detail,project,owner,status,priority,source,source_id,source_url,
       source_due_date,external_issue_id,confidence,needs_clarification,clarification_note,
       extracted_by,revision,source_created_at,source_modified_at,collected_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`).run(
      id, cand.type, cand.title, cand.detail || "", cand.project || "", cand.owner || "",
      cand.type === "waiting" ? "waiting" : "todo",
      cand.priority || 3, sourceName, sourceId,
      (cand.evidence && cand.evidence[0] && cand.evidence[0].url) || null,
      cand.source_due_date || null, cand.external_issue_id || null,
      cand.confidence != null ? cand.confidence : 0.6,
      cand.needs_clarification || 0, cand.clarification_note || "",
      meta.extractedBy || "rules",
      meta.sourceCreatedAt || null, meta.sourceModifiedAt || null, meta.collectedAt || now, now, now
    );

    for (const ev of cand.evidence || []) {
      db.prepare("INSERT INTO evidence(id,record_id,source,quote,context,source_url,observed_at) VALUES (?,?,?,?,?,?,?)")
        .run(newId(), id, sourceName, ev.quote, ev.context || "", ev.url || null, meta.collectedAt || now);
    }
    db.prepare("INSERT OR REPLACE INTO provenance(source,source_id,record_id,first_seen,last_seen) VALUES (?,?,?,?,?)")
      .run(sourceName, sourceItemId, id, now, now);

    return { action: "created", id };
  }

  // Existing record: enrich source-owned fields only, never clobber user edits.
  const patch = {};
  for (const f of IMPORT_FIELDS) {
    if (userOwns(existing, f)) continue;
    const incoming = f === "source_url"
      ? (cand.evidence && cand.evidence[0] && cand.evidence[0].url) || null
      : cand[f];
    if (incoming == null || incoming === "") continue;
    if (String(existing[f] ?? "") !== String(incoming)) patch[f] = incoming;
  }

  db.prepare("UPDATE provenance SET last_seen=? WHERE source=? AND source_id=? AND record_id=?")
    .run(now, sourceName, sourceItemId, existing.id);

  if (!Object.keys(patch).length) return { action: "unchanged", id: existing.id };

  const sets = Object.keys(patch).map((f) => f + "=?").join(",");
  db.prepare("UPDATE records SET " + sets + ", revision=revision+1, updated_at=? WHERE id=?")
    .run(...Object.values(patch), now, existing.id);

  return { action: "updated", id: existing.id, fields: Object.keys(patch) };
}

// --- User mutations. Each records field ownership and bumps the revision. ---

export function applyUserEdit(id, patch, expectedRevision) {
  return tx(() => {
    const rec = db.prepare("SELECT * FROM records WHERE id=?").get(id);
    if (!rec) throw Object.assign(new Error("Record not found"), { code: 404 });
    if (expectedRevision != null && Number(expectedRevision) !== rec.revision) {
      throw Object.assign(new Error("This record changed since you loaded it. Reload and retry."), { code: 409 });
    }

    const allowed = ["status", "priority", "planned_date", "defer_until", "title", "detail",
      "project", "owner", "dismissed", "needs_clarification", "clarification_note", "type"];
    const owned = JSON.parse(rec.user_edited || "{}");
    const now = nowISO();
    const sets = [];
    const vals = [];

    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) continue;
      sets.push(k + "=?");
      vals.push(v);
      owned[k] = now;
    }
    if (!sets.length) return rec;

    sets.push("user_edited=?"); vals.push(JSON.stringify(owned));
    sets.push("revision=revision+1");
    sets.push("updated_at=?"); vals.push(now);
    vals.push(id);

    db.prepare("UPDATE records SET " + sets.join(",") + " WHERE id=?").run(...vals);

    // Read back before reporting success (PRD s12).
    const after = db.prepare("SELECT * FROM records WHERE id=?").get(id);
    for (const k of Object.keys(patch)) {
      if (allowed.includes(k) && String(after[k] ?? "") !== String(patch[k] ?? "")) {
        throw new Error("Save verification failed for field: " + k);
      }
    }
    return after;
  });
}

export function createManual(fields) {
  const id = newId();
  const now = nowISO();
  db.prepare(`INSERT INTO records
    (id,type,title,detail,project,owner,status,priority,source,source_id,planned_date,
     confidence,extracted_by,revision,collected_at,created_at,updated_at,user_edited)
    VALUES (?,?,?,?,?,?,?,?,'manual',NULL,?,1.0,'manual',1,?,?,?,?)`).run(
    id, fields.type || "task", fields.title, fields.detail || "", fields.project || "",
    fields.owner || "", fields.status || "todo", fields.priority || 3,
    fields.planned_date || null, now, now, now,
    JSON.stringify({ title: now, status: now })
  );
  return db.prepare("SELECT * FROM records WHERE id=?").get(id);
}
