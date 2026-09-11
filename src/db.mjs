// Canonical store. SQLite is the authority; the Obsidian vault is a rendered export.
// Implements PRD s11 (record fields, authority-by-field) and s12 (consistency, dedup).
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.CC_DB || join(ROOT, 'data', 'cc.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  detail            TEXT DEFAULT '',
  project           TEXT DEFAULT '',
  owner             TEXT DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'todo',
  priority          INTEGER DEFAULT 3,
  source            TEXT NOT NULL,
  source_id         TEXT,
  source_url        TEXT,
  source_due_date   TEXT,
  planned_date      TEXT,
  defer_until       TEXT,
  external_issue_id TEXT,
  confidence        REAL DEFAULT 1.0,
  needs_clarification INTEGER DEFAULT 0,
  clarification_note TEXT DEFAULT '',
  dismissed         INTEGER DEFAULT 0,
  user_edited       TEXT DEFAULT '{}',
  extracted_by      TEXT DEFAULT 'rules',
  revision          INTEGER NOT NULL DEFAULT 1,
  source_created_at TEXT,
  source_modified_at TEXT,
  collected_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status, dismissed);
CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_source ON records(source, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  quote       TEXT NOT NULL,
  context     TEXT DEFAULT '',
  source_url  TEXT,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_record ON evidence(record_id);

CREATE TABLE IF NOT EXISTS sources (
  name               TEXT PRIMARY KEY,
  enabled            INTEGER NOT NULL DEFAULT 0,
  checkpoint         TEXT,
  last_attempt_at    TEXT,
  last_success_at    TEXT,
  last_status        TEXT DEFAULT 'never_run',
  last_error         TEXT DEFAULT '',
  scope_note         TEXT DEFAULT '',
  items_seen         INTEGER DEFAULT 0,
  coverage_complete  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS raw_items (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  hash         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  occurred_at  TEXT,
  collected_at TEXT NOT NULL,
  processed    INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_src ON raw_items(source, source_id);
CREATE INDEX IF NOT EXISTS idx_raw_unprocessed ON raw_items(processed);

CREATE TABLE IF NOT EXISTS provenance (
  source      TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  PRIMARY KEY (source, source_id, record_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  trigger      TEXT NOT NULL,
  status       TEXT DEFAULT 'running',
  summary      TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS briefings (
  date         TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  body         TEXT NOT NULL,
  coverage     TEXT NOT NULL DEFAULT '{}',
  degraded     INTEGER NOT NULL DEFAULT 0
);


CREATE TABLE IF NOT EXISTS calendar_events (
  id           TEXT PRIMARY KEY,
  source_id    TEXT UNIQUE,
  subject      TEXT NOT NULL,
  series_key   TEXT,
  start_at     TEXT NOT NULL,
  end_at       TEXT,
  duration_min INTEGER,
  organizer    TEXT,
  location     TEXT,
  is_teams     INTEGER DEFAULT 0,
  is_recurring INTEGER DEFAULT 0,
  all_day      INTEGER DEFAULT 0,
  attendees    TEXT DEFAULT '[]',
  agenda       TEXT DEFAULT '',
  collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cal_start ON calendar_events(start_at);
CREATE INDEX IF NOT EXISTS idx_cal_series ON calendar_events(series_key);

CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  title, detail, project, content='records', content_rowid='rowid'
);
`);

db.exec(`
CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid,title,detail,project) VALUES (new.rowid,new.title,new.detail,new.project);
END;
CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts,rowid,title,detail,project) VALUES('delete',old.rowid,old.title,old.detail,old.project);
END;
CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts,rowid,title,detail,project) VALUES('delete',old.rowid,old.title,old.detail,old.project);
  INSERT INTO records_fts(rowid,title,detail,project) VALUES (new.rowid,new.title,new.detail,new.project);
END;
`);

export function registerSource(name) {
  db.prepare('INSERT OR IGNORE INTO sources(name,enabled) VALUES (?,0)').run(name);
}

export const nowISO = () => new Date().toISOString();
export const newId = () => randomUUID();
export const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

export function getSource(name) {
  return db.prepare('SELECT * FROM sources WHERE name=?').get(name);
}

export function updateSource(name, patch) {
  const cur = getSource(name) || {};
  const m = { ...cur, ...patch, name };
  db.prepare(`INSERT INTO sources(name,enabled,checkpoint,last_attempt_at,last_success_at,last_status,last_error,scope_note,items_seen,coverage_complete)
    VALUES (@name,@enabled,@checkpoint,@last_attempt_at,@last_success_at,@last_status,@last_error,@scope_note,@items_seen,@coverage_complete)
    ON CONFLICT(name) DO UPDATE SET enabled=@enabled,checkpoint=@checkpoint,last_attempt_at=@last_attempt_at,
      last_success_at=@last_success_at,last_status=@last_status,last_error=@last_error,scope_note=@scope_note,
      items_seen=@items_seen,coverage_complete=@coverage_complete`).run({
    name: m.name,
    enabled: m.enabled ?? 0,
    checkpoint: m.checkpoint ?? null,
    last_attempt_at: m.last_attempt_at ?? null,
    last_success_at: m.last_success_at ?? null,
    last_status: m.last_status ?? 'never_run',
    last_error: m.last_error ?? '',
    scope_note: m.scope_note ?? '',
    items_seen: m.items_seen ?? 0,
    coverage_complete: m.coverage_complete ?? 0,
  });
}
