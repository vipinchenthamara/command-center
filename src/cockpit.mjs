// Cockpit assembly. Answers "what do I do in the next 90 minutes" rather than
// "what do I owe in total" -- no backlog total is exposed from here by design.
import { db } from "./db.mjs";
import { seriesKey } from "./connectors/calendar.mjs";
import { localDate, scoreRecord } from "./brief.mjs";
import { isBulk } from "./extract/rules.mjs";

const firstName = (s) => String(s || "").trim().split(/[\s,<@]/)[0].toLowerCase();

function dayBounds(cfg, dayOffset = 0) {
  const today = localDate(cfg, new Date(Date.now() + dayOffset * 86400000));
  // Local midnight expressed as UTC, so comparisons against stored ISO stay correct.
  const start = new Date(today + "T00:00:00");
  const end = new Date(start.getTime() + 86400000);
  return { date: today, start, end };
}

// ---------- email triage ----------
// A count of unread mail is a number. A count of mail that needs a reply from you
// is a decision. This separates the two.
const REPLY_CUE = [
  /\b(can|could|would) you\b/i, /\bplease (confirm|advise|review|approve|send|share|update)\b/i,
  /\b(kindly|request you to)\b/i, /\bawait(ing)? your\b/i, /\blet me know\b/i,
  /\byour (input|approval|review|confirmation|sign-?off)\b/i, /\baction (required|needed)\b/i,
  /\bany update\b/i, /\bfollow(ing)? up\b/i, /\?\s*$/m,
];

// Fully automated senders. Deliberately narrow: a "support team" is usually a human.
const AUTO_SENDER = /(quarantine@|@messaging\.microsoft|noreply|no-reply|donotreply|^alerts?@|@e\.|@em\.|@marketing\.)/i;

// "Needs a reply" is not "unread". The real question is whether YOU have answered the
// thread. Sent mail carries the same ConversationID, so a reply you already sent closes
// the loop even if the original is still sitting there unread.
export function triageInbox(cfg, sinceISO) {
  const rows = db.prepare(
    "SELECT source_id,payload,occurred_at FROM raw_items WHERE source='outlook' ORDER BY occurred_at DESC LIMIT 500"
  ).all().map((r) => { try { return { id: r.source_id, p: JSON.parse(r.payload) }; } catch { return null; } })
    .filter(Boolean);

  // Conversations you have already replied to, and when.
  const repliedAt = new Map();
  for (const { p } of rows) {
    if (p.direction !== "outbound" || !p.conversation) continue;
    const prev = repliedAt.get(p.conversation);
    if (!prev || p.receivedAt > prev) repliedAt.set(p.conversation, p.receivedAt);
  }

  const meParts = [(cfg.identity && cfg.identity.email) || "", (cfg.identity && cfg.identity.name) || ""]
    .filter(Boolean).map((s) => s.toLowerCase());
  const addressedToMe = (p) => {
    const to = String(p.to || "").toLowerCase();
    return meParts.some((m) => m && to.includes(m));
  };

  const needsReply = [];
  let fyi = 0, unread = 0;

  for (const { id, p } of rows) {
    if (p.direction === "outbound") continue;
    if (p.unread) unread++;
    if (isBulk(p)) continue;
    if (AUTO_SENDER.test(String(p.senderEmail || "") + " " + String(p.senderName || ""))) continue;

    // Already answered after it arrived? Then nothing is owed.
    const answered = p.conversation && repliedAt.has(p.conversation)
      && repliedAt.get(p.conversation) > p.receivedAt;
    if (answered) continue;

    const direct = addressedToMe(p);
    const body = String(p.body || "");
    const asks = REPLY_CUE.some((re) => re.test(body) || re.test(p.subject || ""));

    // Owed if it asks something and was aimed at you, or you flagged it yourself.
    if ((asks && direct) || p.flagged) {
      needsReply.push({
        id,
        subject: p.subject || "(no subject)",
        from: p.senderName || p.senderEmail || "",
        at: p.receivedAt,
        flagged: !!p.flagged,
        unread: !!p.unread,
      });
    } else if (p.unread) fyi++;
  }

  needsReply.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { needsReply: needsReply.slice(0, 12), needsReplyCount: needsReply.length, fyi, unread };
}

// ---------- meeting prep ----------
// For a meeting, the useful prep is: what did we agree last time that is still open,
// and what do I owe the people who will be in the room.
export function prepFor(event, cfg) {
  const attendees = JSON.parse(event.attendees || "[]");
  const names = attendees.map(firstName).filter((n) => n.length > 2);
  const me = firstName((cfg.identity && cfg.identity.name) || "");
  const others = names.filter((n) => n !== me);

  const open = db.prepare(`SELECT * FROM records
    WHERE dismissed=0 AND status NOT IN ('done','cancelled')`).all();

  const key = event.series_key || seriesKey(event.subject);

  // 1. Still-open items that came out of a previous run of this same meeting.
  const fromSeries = open.filter((r) => {
    if (r.source !== "granola") return false;
    const detail = String(r.detail || "");
    const m = detail.match(/Meeting:\s*([^-\n]+)/i);
    return m ? seriesKey(m[1]) === key && key.length > 3 : false;
  });

  // 2. Items you owe, or are waiting on, involving someone in the room.
  const seen = new Set(fromSeries.map((r) => r.id));
  const withPeople = open.filter((r) => {
    if (seen.has(r.id)) return false;
    const hay = (String(r.owner || "") + " " + String(r.title || "")).toLowerCase();
    return others.some((n) => hay.includes(n));
  });

  // Junk titles (mail-header fragments, @mention blobs) are never useful prep.
  const usable = (r) => !/mailto:|^@|<[^>]+@/.test(String(r.title || "")) && String(r.title).length > 12;

  const youOwe = [...fromSeries, ...withPeople].filter((r) => r.type === "task" && usable(r)).slice(0, 5);
  const waitingOn = [...fromSeries, ...withPeople].filter((r) => r.type === "waiting" && usable(r)).slice(0, 5);
  const issues = fromSeries.filter((r) => r.type === "issue" && usable(r)).slice(0, 3);

  const lastNote = db.prepare(`SELECT payload, occurred_at FROM raw_items
    WHERE source='granola' ORDER BY occurred_at DESC LIMIT 20`).all()
    .map((r) => { try { return { p: JSON.parse(r.payload), at: r.occurred_at }; } catch { return null; } })
    .filter(Boolean)
    .find((x) => seriesKey(x.p.title) === key && key.length > 3);

  return {
    youOwe,
    waitingOn,
    issues,
    lastMet: lastNote ? lastNote.at : null,
    lastNoteUrl: lastNote ? lastNote.p.url || "" : "",
    total: youOwe.length + waitingOn.length + issues.length,
  };
}

// ---------- the day ----------
export function buildCockpit(cfg) {
  const { date, start, end } = dayBounds(cfg);
  const now = new Date();

  const events = db.prepare(
    "SELECT * FROM calendar_events WHERE start_at >= ? AND start_at < ? ORDER BY start_at"
  ).all(start.toISOString(), end.toISOString());

  const meetings = events.map((e) => {
    const s = new Date(e.start_at);
    const en = new Date(e.end_at || s.getTime() + (e.duration_min || 30) * 60000);
    return {
      id: e.id,
      subject: e.subject,
      start: e.start_at,
      end: en.toISOString(),
      startLabel: s.toTimeString().slice(0, 5),
      endLabel: en.toTimeString().slice(0, 5),
      durationMin: e.duration_min,
      organizer: e.organizer,
      isTeams: !!e.is_teams,
      attendees: JSON.parse(e.attendees || "[]"),
      agenda: e.agenda || "",
      past: en < now,
      live: s <= now && en > now,
      minutesAway: Math.round((s - now) / 60000),
      prep: prepFor(e, cfg),
    };
  });

  const next = meetings.find((m) => !m.past && !m.live) || null;
  const live = meetings.find((m) => m.live) || null;

  // Once today's meetings are behind you, the useful horizon is tomorrow morning.
  const tomorrow = dayBounds(cfg, 1);
  const tomorrowEvents = db.prepare(
    "SELECT * FROM calendar_events WHERE start_at >= ? AND start_at < ? ORDER BY start_at"
  ).all(tomorrow.start.toISOString(), tomorrow.end.toISOString()).map((e) => {
    const s = new Date(e.start_at);
    return {
      id: e.id, subject: e.subject, start: e.start_at,
      startLabel: s.toTimeString().slice(0, 5),
      attendees: JSON.parse(e.attendees || "[]"),
      isTeams: !!e.is_teams,
      prep: prepFor(e, cfg),
    };
  });
  const dayDone = !next && !live && meetings.length > 0;

  // Gaps between meetings during working hours are where committed work actually fits.
  const gaps = [];
  const dayStart = new Date(start.getTime() + 9 * 3600000);
  const dayEnd = new Date(start.getTime() + 19 * 3600000);
  let cursor = now > dayStart ? now : dayStart;
  for (const m of meetings) {
    const s = new Date(m.start);
    if (s > cursor) {
      const mins = Math.round((s - cursor) / 60000);
      if (mins >= 30) gaps.push({ from: cursor.toISOString(), to: m.start, minutes: mins });
    }
    const e = new Date(m.end);
    if (e > cursor) cursor = e;
  }
  if (cursor < dayEnd) {
    const mins = Math.round((dayEnd - cursor) / 60000);
    if (mins >= 30) gaps.push({ from: cursor.toISOString(), to: dayEnd.toISOString(), minutes: mins });
  }

  // Committed: what you actually said you'd do today. Capped, deliberately.
  const committed = db.prepare(`SELECT * FROM records
    WHERE dismissed=0 AND status NOT IN ('done','cancelled') AND planned_date=?
    ORDER BY priority ASC, updated_at DESC`).all(date)
    .map((r) => ({ ...r, ...scoreRecord(r, date) }));

  const clearedToday = db.prepare(`SELECT COUNT(*) c FROM records
    WHERE status='done' AND date(updated_at)=date('now')`).get().c;

  // Candidates to fill the remaining slots, never shown as a total.
  const suggestions = db.prepare(`SELECT * FROM records
    WHERE dismissed=0 AND status NOT IN ('done','cancelled')
      AND (planned_date IS NULL OR planned_date <> ?)
      AND (defer_until IS NULL OR defer_until <= date('now'))
      AND type IN ('task','issue')`).all(date)
    .map((r) => ({ ...r, ...scoreRecord(r, date) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Arrivals since the last completed run, i.e. "while you were away".
  const lastRun = db.prepare("SELECT started_at FROM runs WHERE status!='running' ORDER BY started_at DESC LIMIT 1 OFFSET 1").get();
  const sinceISO = lastRun ? lastRun.started_at : new Date(Date.now() - 86400000).toISOString();

  const newRecords = db.prepare(`SELECT * FROM records
    WHERE dismissed=0 AND created_at >= ? AND status NOT IN ('done','cancelled')`).all(sinceISO);

  const yesterday = dayBounds(cfg, -1);
  const yesterdayMeetingActions = db.prepare(`SELECT r.* FROM records r
    WHERE r.source='granola' AND r.dismissed=0
      AND r.status NOT IN ('done','cancelled')
      AND r.created_at >= ?`).all(yesterday.start.toISOString());

  const inbox = triageInbox(cfg, sinceISO);

  const sources = db.prepare("SELECT * FROM sources ORDER BY name").all().map((s) => ({
    name: s.name,
    enabled: !!s.enabled,
    status: s.last_status,
    complete: !!s.coverage_complete,
    lastSuccess: s.last_success_at,
    error: s.last_error,
    scope: s.scope_note,
  }));

  return {
    date,
    now: now.toISOString(),
    clock: now.toTimeString().slice(0, 5),
    timezone: cfg.timezone,
    meetings,
    next,
    live,
    gaps,
    dayDone,
    tomorrow: { date: tomorrow.date, meetings: tomorrowEvents },
    committed,
    committedCap: cfg.committedCap || 3,
    suggestions,
    clearedToday,
    inbox,
    arrivals: {
      since: sinceISO,
      newIssues: newRecords.filter((r) => r.type === "issue"),
      newTasks: newRecords.filter((r) => r.type === "task"),
      newWaiting: newRecords.filter((r) => r.type === "waiting"),
      meetingActions: yesterdayMeetingActions.filter((r) => r.type === "task").slice(0, 6),
    },
    sources,
    degraded: sources.some((s) => s.enabled && (s.status !== "ok" || !s.complete)),
  };
}
