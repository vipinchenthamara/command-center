// Granola public API (https://public-api.granola.ai/v1).
//
// Preferred over the MCP route: a static API key needs no browser sign-in and no token
// refresh, so the scheduled 07:30 run keeps working without you. Business/Enterprise plans.
//
// The key is read from GRANOLA_API_KEY, else data/granola-auth.json (mode 0600).
// It is never written to config.json and never rendered into the vault.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT } from "../db.mjs";

const AUTH_PATH = join(ROOT, "data", "granola-auth.json");
const DEFAULT_BASE = "https://public-api.granola.ai/v1";

// Documented limits are 5 req/sec sustained, 25 burst. Stay well under.
const MIN_GAP_MS = 220;
let lastCall = 0;

function loadAuth() {
  if (!existsSync(AUTH_PATH)) return {};
  try { return JSON.parse(readFileSync(AUTH_PATH, "utf8")); } catch { return {}; }
}

export function saveApiKey(key) {
  mkdirSync(dirname(AUTH_PATH), { recursive: true });
  const j = { ...loadAuth(), api_key: key, api_base: DEFAULT_BASE };
  writeFileSync(AUTH_PATH, JSON.stringify(j, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(AUTH_PATH, 0o600); } catch {}
}

export function granolaApiState() {
  const key = process.env.GRANOLA_API_KEY || loadAuth().api_key || "";
  return { configured: !!key, source: process.env.GRANOLA_API_KEY ? "env" : key ? "file" : "none" };
}

function apiKey() {
  const key = process.env.GRANOLA_API_KEY || loadAuth().api_key || "";
  if (!key) { const e = new Error("No Granola API key. Run: node cc.mjs granola-key <grn_...>"); e.auth = true; throw e; }
  return key;
}

const base = () => loadAuth().api_base || DEFAULT_BASE;

async function get(path, params = {}) {
  const gap = Date.now() - lastCall;
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastCall = Date.now();

  const url = new URL(base() + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + apiKey(), Accept: "application/json" },
  });

  if (res.status === 401 || res.status === 403) {
    const e = new Error("Granola rejected the API key (HTTP " + res.status + "). Check it is valid and the plan still includes API access.");
    e.auth = true; throw e;
  }
  if (res.status === 429) {
    const e = new Error("Granola rate limit hit. The next run will resume from the checkpoint.");
    e.retry = true; throw e;
  }
  if (!res.ok) throw new Error("Granola API " + path + " -> HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

// The API rejects page_size above 30 with a VALIDATION_ERROR.
const MAX_PAGE = 30;

// Notes changed since `sinceISO`, following cursor pagination up to `max`.
export async function listNotes(sinceISO, max = 50) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20 && out.length < max; page++) {
    const j = await get("/notes", {
      updated_after: sinceISO,
      page_size: Math.min(MAX_PAGE, max - out.length),
      cursor,
    });
    const batch = j.notes || j.data || [];
    out.push(...batch);
    if (!j.hasMore || !j.cursor || !batch.length) break;
    cursor = j.cursor;
  }
  return out.slice(0, max);
}

export async function getNote(id) {
  const j = await get("/notes/" + encodeURIComponent(id));
  return j.note || j;
}

// Transcript segments carry speaker attribution; "me" marks the account owner, which
// is what lets a spoken commitment become YOUR task rather than someone else's.
export async function getTranscript(id, maxSegments = 1200) {
  const segs = [];
  let cursor = null;
  for (let page = 0; page < 12 && segs.length < maxSegments; page++) {
    let j;
    try { j = await get("/notes/" + encodeURIComponent(id) + "/transcript", { cursor }); }
    catch (e) { if (e.auth) throw e; break; }
    const batch = j.transcript || j.segments || j.data || [];
    if (!Array.isArray(batch) || !batch.length) break;
    segs.push(...batch);
    if (!j.hasMore || !j.cursor) break;
    cursor = j.cursor;
  }
  return segs.slice(0, maxSegments);
}

// Render segments as speaker-labelled lines, collapsing consecutive turns.
export function renderTranscript(segments, meLabel = "Me") {
  const lines = [];
  let who = null, buf = [];
  const flush = () => {
    if (buf.length) lines.push(who + ": " + buf.join(" ").replace(/\s+/g, " ").trim());
    buf = [];
  };
  for (const s of segments) {
    const sp = s.speaker || {};
    const name = sp.attribution === "me" ? meLabel
      : sp.name || sp.display_name || (sp.attribution === "them" ? "Participant" : "Speaker");
    if (name !== who) { flush(); who = name; }
    if (s.text) buf.push(s.text);
  }
  flush();
  return lines.join("\n");
}

export { AUTH_PATH, DEFAULT_BASE };
