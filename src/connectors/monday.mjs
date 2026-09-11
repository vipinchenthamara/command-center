// monday.com issue reading. Read-only by construction: no mutation query is ever built.
import { db, hash, newId, nowISO, updateSource } from '../db.mjs';

const API = 'https://api.monday.com/v2';

async function gql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error('monday.com rejected the API token'); e.auth = true; throw e;
  }
  if (!res.ok) throw new Error('monday.com HTTP ' + res.status);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors.map(x => x.message).join('; '));
  return json.data;
}

export async function collectMonday(cfg) {
  const c = cfg.monday || {};
  if (!c.enabled || !c.apiToken) {
    updateSource('monday', { enabled: 0, last_status: 'not_configured', coverage_complete: 0,
      last_error: 'No API token. Set MONDAY_API_TOKEN or add it in Connections.' });
    return { ok: false, skipped: true, reason: 'not_configured' };
  }

  updateSource('monday', { enabled: 1, last_attempt_at: nowISO() });
  try {
    let boardIds = c.boardIds || [];
    if (!boardIds.length) {
      const d = await gql(c.apiToken, '{ boards(limit:20, state:active){ id name } }');
      boardIds = (d.boards || []).map(b => b.id);
    }
    if (!boardIds.length) {
      updateSource('monday', { enabled: 1, last_attempt_at: nowISO(), last_status: 'partial',
        last_error: 'Token valid but no accessible boards found.', coverage_complete: 0 });
      return { ok: true, items: 0, complete: false };
    }

    const q = 'query($ids:[ID!]){ boards(ids:$ids){ id name items_page(limit:100){ cursor items { id name updated_at created_at url column_values{ id text type } updates(limit:3){ id body created_at creator{ name } } } } } }';
    const data = await gql(c.apiToken, q, { ids: boardIds.map(String) });

    const collectedAt = nowISO();
    let count = 0, complete = true;
    const ins = db.prepare('INSERT INTO raw_items(id,source,source_id,hash,payload,occurred_at,collected_at,processed) VALUES (?,?,?,?,?,?,?,0) ON CONFLICT(source,source_id) DO UPDATE SET hash=excluded.hash,payload=excluded.payload,collected_at=excluded.collected_at,processed=CASE WHEN raw_items.hash=excluded.hash THEN raw_items.processed ELSE 0 END');

    for (const b of data.boards || []) {
      if (b.items_page && b.items_page.cursor) complete = false;
      for (const it of (b.items_page && b.items_page.items) || []) {
        const cols = {};
        for (const cv of it.column_values || []) if (cv.text) cols[cv.id] = cv.text;
        const payload = {
          sourceId: b.id + ':' + it.id, boardId: b.id, boardName: b.name, itemId: it.id,
          title: it.name, url: it.url, columns: cols,
          status: cols.status || cols.status4 || '',
          owner: cols.person || cols.people || '',
          dueDate: cols.date || cols.date4 || cols.due_date || '',
          updates: (it.updates || []).map(u => ({
            body: String(u.body || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 800),
            by: (u.creator && u.creator.name) || '', at: u.created_at })),
          createdAt: it.created_at, modifiedAt: it.updated_at,
        };
        ins.run(newId(), 'monday', payload.sourceId, hash(JSON.stringify(payload)),
          JSON.stringify(payload), it.updated_at, collectedAt);
        count++;
      }
    }

    updateSource('monday', {
      enabled: 1, last_attempt_at: collectedAt, last_success_at: collectedAt,
      last_status: complete ? 'ok' : 'partial',
      last_error: complete ? '' : 'More items exist than were read this run (page limit).',
      scope_note: (data.boards || []).length + ' board(s): ' + (data.boards || []).map(b => b.name).join(', '),
      items_seen: count, coverage_complete: complete ? 1 : 0,
    });
    return { ok: true, items: count, complete };
  } catch (e) {
    updateSource('monday', { enabled: 1, last_attempt_at: nowISO(),
      last_status: e.auth ? 'auth_required' : 'error', last_error: e.message, coverage_complete: 0 });
    return { ok: false, error: e.message };
  }
}
