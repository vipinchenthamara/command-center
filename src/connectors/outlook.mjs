// Outlook collection over local COM. No app registration, no tokens, no browser.
// Verified on this machine: reading .Body does not alter UnRead state (PRD A14).
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, db, hash, newId, nowISO, getSource, updateSource } from '../db.mjs';

const SCRIPT = join(ROOT, 'src', 'connectors', 'outlook.ps1');

function runPowerShell(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { ps.kill(); reject(new Error('Outlook collection timed out')); }, timeoutMs);
    ps.stderr.on('data', (d) => { stderr += d.toString(); });
    ps.on('error', (e) => { clearTimeout(timer); reject(e); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`PowerShell exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve();
    });
  });
}

export async function collectOutlook(cfg) {
  const src = getSource('outlook');
  updateSource('outlook', { enabled: 1, last_attempt_at: nowISO() });

  // Resume from the last verified checkpoint, minus a deliberate overlap so
  // late-arriving and edited items are re-examined (PRD s7).
  const overlapMs = (cfg.overlapHours || 12) * 3600 * 1000;
  const since = src?.checkpoint
    ? new Date(new Date(src.checkpoint).getTime() - overlapMs)
    : new Date(Date.now() - (cfg.lookbackDays || 3) * 86400000);

  const outFile = join(tmpdir(), `cc_outlook_${Date.now()}.json`);
  let payload;
  try {
    await runPowerShell([
      '-OutFile', outFile,
      '-SinceUtc', since.toISOString(),
      '-MaxItems', String(cfg.outlook.maxItems ?? 400),
      '-BodyChars', String(cfg.outlook.bodyChars ?? 2500),
      '-Folders', (cfg.outlook.folders || ['inbox', 'sent']).join(','),
    ]);
    payload = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch (e) {
    updateSource('outlook', {
      enabled: 1, last_attempt_at: nowISO(), last_status: 'error',
      last_error: e.message, coverage_complete: 0,
    });
    return { ok: false, error: e.message, items: 0 };
  } finally {
    try { unlinkSync(outFile); } catch {}
  }

  if (!payload.ok) {
    updateSource('outlook', {
      enabled: 1, last_attempt_at: nowISO(), last_status: 'error',
      last_error: payload.error || 'unknown', coverage_complete: 0,
    });
    return { ok: false, error: payload.error, items: 0 };
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const collectedAt = nowISO();
  let stored = 0, unchanged = 0, newest = src?.checkpoint ? new Date(src.checkpoint) : new Date(0);

  const ins = db.prepare(`INSERT INTO raw_items(id,source,source_id,hash,payload,occurred_at,collected_at,processed)
    VALUES (?,?,?,?,?,?,?,0)
    ON CONFLICT(source,source_id) DO UPDATE SET
      hash=excluded.hash, payload=excluded.payload, collected_at=excluded.collected_at,
      processed=CASE WHEN raw_items.hash=excluded.hash THEN raw_items.processed ELSE 0 END`);

  for (const it of items) {
    // Hash covers only fields that change meaning. Re-collecting an unchanged
    // message therefore never re-triggers extraction (PRD A05).
    const h = hash([it.subject, it.body, it.senderEmail, it.to, it.cc, it.modifiedAt].join('|'));
    const prev = db.prepare('SELECT hash FROM raw_items WHERE source=? AND source_id=?').get('outlook', it.sourceId);
    if (prev?.hash === h) unchanged++; else stored++;
    ins.run(newId(), 'outlook', it.sourceId, h, JSON.stringify(it), it.receivedAt, collectedAt);
    const t = new Date(it.receivedAt);
    if (t > newest) newest = t;
  }

  // Only advance the checkpoint when coverage was actually complete (PRD s7).
  const complete = payload.coverageComplete !== false;
  updateSource('outlook', {
    enabled: 1,
    checkpoint: complete && items.length ? newest.toISOString() : src?.checkpoint ?? null,
    last_attempt_at: collectedAt,
    last_success_at: collectedAt,
    last_status: complete ? 'ok' : 'partial',
    last_error: complete ? '' : `Item cap reached (${cfg.outlook.maxItems}); older mail not reviewed this run.`,
    scope_note: `${payload.account} — folders: ${(payload.folders || []).map(f => `${f.name}(${f.items})`).join(', ')}`,
    items_seen: items.length,
    coverage_complete: complete ? 1 : 0,
  });

  return { ok: true, items: items.length, new: stored, unchanged, account: payload.account, complete };
}
