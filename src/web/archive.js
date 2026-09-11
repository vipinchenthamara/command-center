// The backlog lives here, deliberately off the cockpit. Totals are fine on this page —
// you came looking for them.
const TOKEN = document.querySelector('meta[name="cc-token"]').content;
const $ = (s) => document.querySelector(s);
const el = (t, cls, txt) => { const n = document.createElement(t); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

let ALL = [];
let filter = { type: "all", status: "open" };
let query = "";

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
  toast._t = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2200);
}

const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const firstWord = (s) => String(s || "").trim().split(/[\s,<@]/)[0];

function matches(r) {
  if (filter.status === "open" && (r.status === "done" || r.status === "cancelled")) return false;
  if (filter.status === "done" && r.status !== "done") return false;
  if (filter.type !== "all" && r.type !== filter.type) return false;
  if (query) {
    const hay = (r.title + " " + (r.detail || "") + " " + (r.project || "") + " " + (r.owner || "")).toLowerCase();
    if (!hay.includes(query.toLowerCase())) return false;
  }
  return true;
}

function renderFilters() {
  const root = $("#filters");
  const counts = {};
  for (const r of ALL) counts[r.type] = (counts[r.type] || 0) + 1;

  const mk = (label, active, onClick) => {
    const b = el("button", "btn" + (active ? " btn-primary" : ""), label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };

  root.replaceChildren();
  for (const s of ["open", "done", "all"]) {
    root.append(mk(s.toUpperCase(), filter.status === s, () => { filter.status = s; render(); }));
  }
  root.append(el("span", null, " "));
  root.append(mk("ALL TYPES", filter.type === "all", () => { filter.type = "all"; render(); }));
  for (const t of ["task", "waiting", "issue", "decision", "discussion", "clarification"]) {
    if (!counts[t]) continue;
    root.append(mk(t.toUpperCase() + " " + counts[t], filter.type === t, () => { filter.type = t; render(); }));
  }
}

function render() {
  renderFilters();
  const rows = ALL.filter(matches)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  $("#shown").textContent = rows.length + " shown";
  const list = $("#list");
  if (!rows.length) { list.replaceChildren(el("div", "empty", "Nothing matches")); return; }

  list.replaceChildren(...rows.slice(0, 400).map((r) => {
    const row = el("div", "grp-item");
    row.style.padding = "9px 14px";
    row.style.borderBottom = "1px solid var(--line)";
    row.append(el("span", "from", r.type.toUpperCase()));
    const main = el("span", "txt");
    main.style.whiteSpace = "normal";
    main.textContent = trunc(r.title, 130);
    row.append(main);
    const meta = el("span", "from");
    meta.style.minWidth = "auto";
    meta.textContent = [r.source, r.owner ? "→ " + firstWord(r.owner) : "", r.status !== "todo" ? r.status : ""]
      .filter(Boolean).join(" · ");
    row.append(meta);
    row.addEventListener("click", () => openDrawer(r.id));
    return row;
  }));
}

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
  status.addEventListener("change", () => update(r.id, { status: status.value }, r.revision));

  const planned = el("input"); planned.type = "date"; planned.value = r.planned_date || "";
  planned.addEventListener("change", () => update(r.id, { planned_date: planned.value || null }, r.revision));

  b.append(field("STATUS", status), field("COMMIT TO DATE", planned));

  b.append(el("h3", null, "EVIDENCE"));
  if (!r.evidence.length) b.append(el("div", "empty", "No stored evidence"));
  for (const e of r.evidence) {
    const d = el("div", "ev");
    const q = el("q"); q.textContent = e.quote; d.append(q);
    if (e.context) d.append(el("div", "ctx", e.context));
    b.append(d);
  }

  b.append(el("h3", null, "PROVENANCE"));
  b.append(el("div", "meta-line",
    "SOURCE " + r.source + "  ·  VIA " + r.extracted_by + "  ·  REV " + r.revision +
    "  ·  CONF " + Math.round((r.confidence || 0) * 100) + "%"));

  const dis = el("button", "btn", "DISMISS");
  dis.type = "button";
  dis.addEventListener("click", () => update(r.id, { dismissed: 1 }, r.revision));
  b.append(el("div", "dfield"), dis);

  $("#drawer").hidden = false;
  $("#drawer-scrim").hidden = false;
  $("#drawer-close").focus();
}

const closeDrawer = () => { $("#drawer").hidden = true; $("#drawer-scrim").hidden = true; };

async function update(id, patch, revision) {
  try {
    await api("/api/record/update", { method: "POST", body: JSON.stringify({ id, patch, revision }) });
    toast("saved");
    closeDrawer();
    await load();
  } catch (e) {
    toast(e.status === 409 ? "changed elsewhere — reloading" : "save failed: " + e.message, true);
    await load();
  }
}

async function load() {
  try {
    const s = await api("/api/state");
    ALL = s.records || [];
    const open = ALL.filter((r) => r.status !== "done" && r.status !== "cancelled").length;
    $("#total").textContent = String(ALL.length);
    $("#total-sub").textContent = open + " open · " + (ALL.length - open) + " closed";
    $("#datestamp").textContent = s.today + " · " + (s.timezone || "");
    render();
  } catch (e) {
    $("#list").replaceChildren(el("p", "loading", "LINK DOWN — " + e.message));
  }
}

$("#back").addEventListener("click", () => { window.location.href = "/"; });
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-scrim").addEventListener("click", closeDrawer);
let qt = null;
$("#q").addEventListener("input", (e) => {
  query = e.target.value.trim();
  clearTimeout(qt);
  qt = setTimeout(render, 200);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
});

await load();
