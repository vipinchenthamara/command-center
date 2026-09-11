const TOKEN = document.querySelector('meta[name="cc-token"]').content;
const $ = (s) => document.querySelector(s);
const el = (t, cls, txt) => { const n = document.createElement(t); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

let C = null;          // cockpit payload
let tickTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-CC-Token": TOKEN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || res.statusText), { status: res.status });
  return data;
}

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2400);
}

const firstWord = (s) => String(s || "").trim().split(/[\s,<@]/)[0];
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

// ── T-minus. The only continuously live element on the screen. ──
function renderTminus() {
  if (!C) return;
  const tm = $("#tminus"), sub = $("#tminus-sub"), lbl = $(".tminus-label");
  const target = C.live || C.next;

  if (C.live) {
    lbl.textContent = "IN PROGRESS";
    const endsIn = Math.max(0, Math.round((new Date(C.live.end) - Date.now()) / 60000));
    tm.textContent = "LIVE +" + endsIn + "m";
    tm.className = "tminus";
    sub.textContent = C.live.subject;
    return;
  }
  if (!target) {
    lbl.textContent = C.dayDone ? "DAY COMPLETE" : "NO CONTACT SCHEDULED";
    const t0 = C.tomorrow && C.tomorrow.meetings[0];
    tm.textContent = t0 ? "TOMORROW" : "CLEAR";
    tm.className = "tminus is-idle";
    sub.textContent = t0 ? t0.startLabel + " · " + t0.subject : "Nothing else on the calendar today.";
    return;
  }
  const mins = Math.max(0, Math.round((new Date(target.start) - Date.now()) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  lbl.textContent = "NEXT CONTACT";
  tm.textContent = "T-" + (h ? h + "h " : "") + m + "m";
  tm.className = "tminus" + (mins <= 15 ? " is-soon" : "");
  sub.textContent = target.startLabel + " · " + target.subject;
}

function renderRail() {
  const rail = $("#source-rail");
  rail.replaceChildren(...C.sources.map((s) => {
    let cls = "src off", label = "OFFLINE";
    if (s.enabled && s.status === "ok" && s.complete) { cls = "src on"; label = "ONLINE"; }
    else if (s.enabled && (s.status === "partial" || !s.complete)) { cls = "src warn"; label = "PARTIAL"; }
    else if (s.enabled && s.status === "auth_required") { cls = "src err"; label = "AUTH"; }
    else if (s.enabled && s.status === "error") { cls = "src err"; label = "ERROR"; }
    const d = el("div", cls);
    d.title = (s.scope || "") + (s.error ? "\n" + s.error : "");
    d.append(el("span", "led"), document.createTextNode(s.name + " " + label));
    return d;
  }));
  $("#clock").textContent = C.clock;
  const d = new Date(C.now);
  $("#datestamp").textContent =
    d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }).toUpperCase() +
    " · " + (C.timezone || "");
}

// ── prep lines under a meeting ──
function prepBlock(m) {
  const p = m.prep;
  if (!p.total) return null;
  const wrap = el("div", "prep");
  wrap.append(el("div", "prep-head",
    "PREP · " + p.total + " OPEN" + (p.lastMet ? " SINCE " + String(p.lastMet).slice(0, 10) : "")));

  const line = (rec, cls, who) => {
    const d = el("div", "prep-line " + cls);
    d.append(el("span", "who", who), el("span", null, trunc(rec.title, 76)));
    d.addEventListener("click", (e) => { e.stopPropagation(); openDrawer(rec.id); });
    wrap.append(d);
  };
  p.youOwe.slice(0, 3).forEach((r) => line(r, "owe", "YOU OWE"));
  p.waitingOn.slice(0, 3).forEach((r) => line(r, "wait", firstWord(r.owner) || "WAITING"));
  p.issues.slice(0, 2).forEach((r) => line(r, "iss", "ISSUE"));

  const shown = Math.min(3, p.youOwe.length) + Math.min(3, p.waitingOn.length) + Math.min(2, p.issues.length);
  if (p.total > shown) wrap.append(el("div", "prep-more", "+ " + (p.total - shown) + " more"));
  return wrap;
}

function renderTimeline() {
  const root = $("#timeline");
  const nodes = [];

  if (!C.meetings.length) {
    nodes.push(el("div", "empty", "No meetings scheduled today"));
  }

  // Interleave meetings with the gaps that sit before them.
  const gapsBefore = (startISO) => C.gaps.filter((g) => g.to === startISO);

  for (const m of C.meetings) {
    for (const g of gapsBefore(m.start)) nodes.push(gapRow(g));

    const row = el("div", "tl-row" + (m.live ? " is-live" : m.past ? " is-past" : (C.next && C.next.id === m.id ? " is-next" : "")));
    row.append(el("div", "tl-time", m.startLabel));

    const node = el("div", "tl-node");
    const card = el("div", "meet");
    card.append(el("div", "meet-title", m.subject));
    const bits = [m.durationMin + "m", m.attendees.length + " attendees"];
    if (m.isTeams) bits.push("teams");
    if (m.organizer) bits.push("org " + firstWord(m.organizer));
    card.append(el("div", "meet-sub", bits.join(" · ")));
    const pb = prepBlock(m);
    if (pb) card.append(pb);
    node.append(card);
    row.append(node);
    nodes.push(row);
  }

  // Any trailing gap after the last meeting.
  const lastEnd = C.meetings.length ? C.meetings[C.meetings.length - 1].end : null;
  for (const g of C.gaps) {
    if (!C.meetings.some((m) => m.start === g.to)) nodes.push(gapRow(g));
  }

  if (C.dayDone && C.tomorrow.meetings.length) {
    const h = el("div", "grp");
    h.append(el("div", "grp-title", "TOMORROW · " + C.tomorrow.date));
    for (const t of C.tomorrow.meetings) {
      const i = el("div", "grp-item");
      i.append(el("span", "from", t.startLabel),
        el("span", "txt", t.subject + (t.prep.total ? "   [" + t.prep.total + " prep]" : "")));
      h.append(i);
    }
    nodes.push(h);
  }

  root.replaceChildren(el("div", "tl", ...[]), ...[]);
  const tl = el("div", "tl");
  nodes.forEach((n) => tl.append(n));
  root.replaceChildren(tl);

  const booked = C.meetings.reduce((a, m) => a + (m.durationMin || 0), 0);
  $("#day-meta").textContent = C.meetings.length + " meetings · " + Math.round(booked / 60 * 10) / 10 + "h booked";
}

function gapRow(g) {
  const row = el("div", "tl-gap");
  const from = new Date(g.from);
  row.append(el("div", "tl-time", from.toTimeString().slice(0, 5)));
  const body = el("div", "gap-body");
  const inner = el("div", "gap-inner");
  const hrs = Math.floor(g.minutes / 60), mins = g.minutes % 60;
  inner.append(el("div", "gap-label", "FOCUS WINDOW · " + (hrs ? hrs + "h " : "") + (mins ? mins + "m" : "")));
  // Committed work is what this window is for.
  C.committed.slice(0, 3).forEach((r, i) => {
    const t = el("div", "gap-task");
    t.append(el("span", "idx", String(i + 1) + "."), el("span", null, trunc(r.title, 68)));
    inner.append(t);
  });
  if (!C.committed.length) inner.append(el("div", "gap-task", "Nothing committed yet."));
  body.append(inner);
  row.append(body);
  return row;
}

function renderInbound() {
  const root = $("#inbound");
  const nodes = [];
  const a = C.arrivals;

  const group = (title, count, tone, items, render) => {
    const g = el("div", "grp");
    const head = el("div", "grp-head");
    head.append(el("span", "grp-title", title), el("span", "grp-count " + tone, String(count)));
    g.append(head);
    if (items && items.length) {
      const list = el("div", "grp-list");
      items.forEach((it) => list.append(render(it)));
      g.append(list);
    }
    nodes.push(g);
  };

  group("NEEDS YOUR REPLY", C.inbox.needsReplyCount, C.inbox.needsReplyCount ? "amber" : "dim",
    C.inbox.needsReply.slice(0, 4), (e) => {
      const d = el("div", "grp-item");
      d.append(el("span", "from", trunc(firstWord(e.from) || e.from, 14)), el("span", "txt", e.subject));
      return d;
    });

  group("NEW ISSUES", a.newIssues.length, a.newIssues.length ? "red" : "dim",
    a.newIssues.slice(0, 4), (r) => {
      const d = el("div", "grp-item");
      d.append(el("span", "from", "ISSUE"), el("span", "txt", r.title));
      d.addEventListener("click", () => openDrawer(r.id));
      return d;
    });

  group("FROM MEETINGS", a.meetingActions.length, a.meetingActions.length ? "amber" : "dim",
    a.meetingActions.slice(0, 4), (r) => {
      const d = el("div", "grp-item");
      d.append(el("span", "from", firstWord(r.owner) || "ACTION"), el("span", "txt", r.title));
      d.addEventListener("click", () => openDrawer(r.id));
      return d;
    });

  // Raw volume, kept deliberately quiet: it is context, not a demand.
  const vol = el("div", "grp");
  const vh = el("div", "grp-head");
  vh.append(el("span", "grp-title", "INBOX VOLUME"),
    el("span", "grp-count dim", String(C.inbox.unread)));
  vol.append(vh);
  vol.append(el("div", "slot-sub", C.inbox.unread + " unread · " + C.inbox.fyi + " fyi · rest filtered as bulk"));
  nodes.push(vol);

  root.replaceChildren(...nodes);
  $("#inbound-meta").textContent = "since " + String(a.since).slice(5, 10);
}

function renderCommitted() {
  const root = $("#committed");
  const cap = C.committedCap || 3;
  const nodes = [];

  for (let i = 0; i < cap; i++) {
    const r = C.committed[i];
    if (r) {
      const s = el("div", "slot");
      const chk = el("div", "slot-check");
      const cb = el("input");
      cb.type = "checkbox";
      cb.setAttribute("aria-label", "Mark done: " + r.title);
      cb.addEventListener("click", (e) => { e.stopPropagation(); update(r.id, { status: "done" }, r.revision); });
      chk.append(cb);
      const main = el("div", "slot-main");
      main.append(el("div", "slot-title", r.title));
      main.append(el("div", "slot-sub", [r.type, r.source, r.owner ? "→ " + firstWord(r.owner) : ""].filter(Boolean).join(" · ")));
      main.addEventListener("click", () => openDrawer(r.id));
      s.append(el("span", "slot-idx", String(i + 1)), chk, main);
      nodes.push(s);
    } else {
      const s = el("div", "slot empty-slot");
      s.append(el("span", "slot-idx", String(i + 1)),
        el("div", "slot-main", null));
      s.querySelector(".slot-main").append(el("div", "slot-title", "slot open"));
      nodes.push(s);
    }
  }

  const mom = el("div", "momentum");
  mom.append(el("span", "lbl", "CLEARED TODAY"), el("span", "val", String(C.clearedToday)));
  nodes.push(mom);

  if (C.committed.length < cap && C.suggestions.length) {
    const sg = el("div", "suggest");
    sg.append(el("div", "suggest-head", "READY TO COMMIT"));
    C.suggestions.slice(0, 4).forEach((r) => {
      const row = el("div", "sug");
      const add = el("span", "add", "+");
      add.setAttribute("role", "button");
      add.tabIndex = 0;
      add.title = "Commit to today";
      const commit = () => update(r.id, { planned_date: C.date }, r.revision);
      add.addEventListener("click", commit);
      add.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
      const t = el("span", "t", trunc(r.title, 52));
      t.addEventListener("click", () => openDrawer(r.id));
      row.append(add, t);
      sg.append(row);
    });
    nodes.push(sg);
  }

  root.replaceChildren(...nodes);
  $("#committed-meta").textContent = C.committed.length + " of " + cap;
}

function render() {
  const banner = $("#banner");
  if (C.degraded) {
    const gaps = C.sources.filter((s) => s.enabled && (s.status !== "ok" || !s.complete));
    banner.replaceChildren();
    banner.append(el("b", null, "PARTIAL COVERAGE · "));
    banner.append(document.createTextNode(
      gaps.map((g) => g.name.toUpperCase() + " " + (g.status || "").toUpperCase()).join("  ·  ") +
      " — this view is not the whole picture."));
    banner.hidden = false;
  } else banner.hidden = true;

  renderRail();
  renderTminus();
  renderTimeline();
  renderInbound();
  renderCommitted();
}

// ── drawer ──
async function openDrawer(id) {
  let r;
  try { r = await api("/api/record?id=" + encodeURIComponent(id)); }
  catch (e) { return toast("cannot open: " + e.message, true); }

  $("#drawer-title").textContent = String(r.type || "record").toUpperCase();
  const b = $("#drawer-body");
  b.replaceChildren();
  b.append(el("h3", null, r.title));
  if (r.detail) b.append(el("div", "meta-line", r.detail));

  const field = (label, node) => { const f = el("div", "dfield"); f.append(el("label", null, label), node); return f; };

  const status = el("select");
  ["todo", "in_progress", "waiting", "done", "cancelled"].forEach((s) => {
    const o = el("option", null, s.replace("_", " ").toUpperCase()); o.value = s;
    if (r.status === s) o.selected = true; status.append(o);
  });
  status.addEventListener("change", () => update(r.id, { status: status.value }, r.revision, true));

  const planned = el("input"); planned.type = "date"; planned.value = r.planned_date || "";
  planned.addEventListener("change", () => update(r.id, { planned_date: planned.value || null }, r.revision, true));

  const defer = el("input"); defer.type = "date"; defer.value = r.defer_until || "";
  defer.addEventListener("change", () => update(r.id, { defer_until: defer.value || null }, r.revision, true));

  b.append(field("STATUS", status), field("COMMIT TO DATE", planned), field("DEFER UNTIL", defer));

  b.append(el("div", "dfield").appendChild ? el("h3", null, "EVIDENCE") : el("h3", null, "EVIDENCE"));
  if (!r.evidence.length) b.append(el("div", "empty", "No stored evidence"));
  for (const e of r.evidence) {
    const d = el("div", "ev");
    const q = el("q"); q.textContent = e.quote; d.append(q);
    if (e.context) d.append(el("div", "ctx", e.context));
    b.append(d);
  }

  b.append(el("h3", null, "PROVENANCE"));
  b.append(el("div", "meta-line",
    "SOURCE " + r.source + (r.source_id ? "  ·  " + r.source_id : "") +
    "  ·  VIA " + r.extracted_by + "  ·  REV " + r.revision +
    "  ·  CONF " + Math.round((r.confidence || 0) * 100) + "%"));
  if (Object.keys(r.user_edited).length) {
    b.append(el("div", "meta-line", "YOUR FIELDS: " + Object.keys(r.user_edited).join(", ") + " — imports will not overwrite these"));
  }

  const dis = el("button", "btn", "DISMISS");
  dis.type = "button";
  dis.addEventListener("click", () => { update(r.id, { dismissed: 1 }, r.revision, false); toast("dismissed"); });
  b.append(el("div", "dfield"), dis);

  $("#drawer").hidden = false;
  $("#drawer-scrim").hidden = false;
  $("#drawer-close").focus();
}

const closeDrawer = () => { $("#drawer").hidden = true; $("#drawer-scrim").hidden = true; };

async function update(id, patch, revision, keepDrawer = false) {
  try {
    await api("/api/record/update", { method: "POST", body: JSON.stringify({ id, patch, revision }) });
    toast("saved");
    if (!keepDrawer) closeDrawer();
    await load();
  } catch (e) {
    toast(e.status === 409 ? "changed elsewhere — reloading" : "save failed: " + e.message, true);
    await load();
  }
}

async function load() {
  try {
    C = await api("/api/cockpit");
    $("#refresh").disabled = !!C.running;
    $("#refresh").textContent = C.running ? "SYNCING" : "SYNC";
    render();
  } catch (e) {
    $("#timeline").replaceChildren(el("p", "loading", "LINK DOWN — " + e.message));
  }
}

$("#refresh").addEventListener("click", async () => {
  try {
    const r = await api("/api/refresh", { method: "POST", body: "{}" });
    toast(r.joinedExistingRun ? "joined active run" : "sync started");
    $("#refresh").disabled = true;
    $("#refresh").textContent = "SYNCING";
    const poll = setInterval(async () => {
      await load();
      if (C && !C.running) { clearInterval(poll); toast("sync complete"); }
    }, 1600);
  } catch (e) { toast("sync failed: " + e.message, true); }
});

$("#tab-archive").addEventListener("click", () => { window.location.href = "/archive.html"; });

$("#capture").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#capture-input");
  const title = input.value.trim();
  if (!title) return;
  try {
    await api("/api/record/create", { method: "POST", body: JSON.stringify({ title, type: "task" }) });
    input.value = "";
    toast("logged");
    await load();
  } catch (err) { toast("failed: " + err.message, true); }
});

$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  if (e.key === "c") { e.preventDefault(); $("#capture-input").focus(); }
  if (e.key === "r") { e.preventDefault(); $("#refresh").click(); }
});

await load();
tickTimer = setInterval(renderTminus, 1000 * 20);
setInterval(() => { if (!C || !C.running) load(); }, 60000);
