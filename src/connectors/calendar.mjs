// Calendar collection over local Outlook COM. Every meeting here is already a Teams
// meeting, so this covers "meetings from Teams" without any browser automation.
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, db, newId, nowISO } from "../db.mjs";

const SCRIPT = join(ROOT, "src", "connectors", "calendar.ps1");

// Recurring instances share a subject but not an ID. Normalising the subject gives a
// stable series key, which is what lets "last time we met" find the right prior notes.
export function seriesKey(subject) {
  return String(subject || "")
    .toLowerCase()
    .replace(/[-–—|:]/g, " ")
    .replace(/\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(day|days)?\b/g, " ")
    .replace(/\b(daily|weekly|biweekly|monthly|recurring|meeting|call|sync|cadence|session|catch ?up|standup|stand ?up)\b/g, " ")
    .replace(/\b\d{1,2}([:.]\d{2})?\s*(am|pm)?\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function runPowerShell(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
      { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => { ps.kill(); reject(new Error("Calendar collection timed out")); }, timeoutMs);
    ps.stderr.on("data", (d) => { stderr += d.toString(); });
    ps.on("error", (e) => { clearTimeout(timer); reject(e); });
    ps.on("close", (code) => {
      clearTimeout(timer);
      code !== 0 ? reject(new Error("PowerShell exited " + code + ": " + stderr.slice(0, 300))) : resolve();
    });
  });
}

export async function collectCalendar(cfg) {
  const outFile = join(tmpdir(), "cc_cal_" + Date.now() + ".json");
  let payload;
  try {
    await runPowerShell([
      "-OutFile", outFile,
      "-DaysAhead", String(cfg.calendar?.daysAhead ?? 3),
      "-DaysBack", String(cfg.calendar?.daysBack ?? 2),
      "-MaxItems", String(cfg.calendar?.maxItems ?? 120),
    ]);
    payload = JSON.parse(readFileSync(outFile, "utf8"));
  } catch (e) {
    return { ok: false, error: e.message, items: 0 };
  } finally {
    try { unlinkSync(outFile); } catch {}
  }
  if (!payload.ok) return { ok: false, error: payload.error, items: 0 };

  const now = nowISO();
  const events = Array.isArray(payload.events) ? payload.events : [];

  // Replace the window wholesale: appointments get moved, cancelled and re-timed,
  // so a stale row is worse than a missing one.
  const ins = db.prepare(`INSERT INTO calendar_events
    (id,source_id,subject,series_key,start_at,end_at,duration_min,organizer,location,
     is_teams,is_recurring,all_day,attendees,agenda,collected_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET
      subject=excluded.subject, series_key=excluded.series_key, start_at=excluded.start_at,
      end_at=excluded.end_at, duration_min=excluded.duration_min, organizer=excluded.organizer,
      location=excluded.location, is_teams=excluded.is_teams, attendees=excluded.attendees,
      agenda=excluded.agenda, collected_at=excluded.collected_at`);

  let count = 0;
  for (const e of events) {
    const attendees = [...(e.required || []), ...(e.optional || [])]
      .map((a) => String(a).trim()).filter(Boolean);
    // A recurring instance reuses its GlobalAppointmentID, so key on id+start.
    const sid = (e.sourceId || e.subject) + "@" + e.start;
    ins.run(newId(), sid, e.subject || "(no subject)", seriesKey(e.subject),
      e.start, e.end || null, e.durationMin || 0, e.organizer || "", e.location || "",
      e.isTeams ? 1 : 0, e.isRecurring ? 1 : 0, e.allDay ? 1 : 0,
      JSON.stringify(attendees), e.agenda || "", now);
    count++;
  }

  // Drop anything in the collected window that no longer exists upstream.
  if (events.length) {
    const minStart = events.reduce((a, e) => (e.start < a ? e.start : a), events[0].start);
    const maxStart = events.reduce((a, e) => (e.start > a ? e.start : a), events[0].start);
    db.prepare(`DELETE FROM calendar_events
      WHERE start_at >= ? AND start_at <= ? AND collected_at < ?`).run(minStart, maxStart, now);
  }

  return { ok: true, items: count, complete: true,
    scope: count + " event(s) in window — Outlook calendar, includes Teams meetings" };
}
