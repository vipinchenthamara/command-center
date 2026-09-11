// Granola over its official MCP server (https://mcp.granola.ai/mcp).
//
// Auth is OAuth 2.0 authorization-code + PKCE against a loopback redirect: you sign in
// once in a browser, and the stored refresh token keeps the scheduled 07:30 run working
// unattended thereafter. (The server advertises device-code, but its dynamic-registration
// endpoint only grants authorization_code/refresh_token, so device-code is first-party only.)
// Tokens live in data/granola-auth.json, never in config.json and never in the vault.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT } from "../db.mjs";

const AS = "https://mcp-auth.granola.ai";
const MCP_URL = "https://mcp.granola.ai/mcp";
const AUTH_PATH = join(ROOT, "data", "granola-auth.json");
const SCOPES = "openid profile email offline_access";
const REDIRECT_PORT = 7788;
const REDIRECT_URI = "http://127.0.0.1:" + REDIRECT_PORT + "/callback";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- token store ----------
function loadAuth() {
  if (!existsSync(AUTH_PATH)) return null;
  try { return JSON.parse(readFileSync(AUTH_PATH, "utf8")); } catch { return null; }
}

function saveAuth(a) {
  mkdirSync(dirname(AUTH_PATH), { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify(a, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(AUTH_PATH, 0o600); } catch {}
}

export function granolaAuthState() {
  const a = loadAuth();
  if (!a) return { linked: false };
  return {
    linked: true,
    account: a.account || "",
    expiresAt: a.expires_at || null,
    expired: a.expires_at ? Date.now() > a.expires_at : false,
    canRefresh: !!a.refresh_token,
  };
}

// ---------- dynamic client registration ----------
async function registerClient() {
  const res = await fetch(AS + "/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Personal Command Center",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error("Client registration failed: HTTP " + res.status + " " + (await res.text()).slice(0, 300));
  return res.json();
}

// One-shot loopback listener that captures ?code= and then closes.
function awaitRedirect(expectedState, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><body style=\"font:16px system-ui;background:#0a0f1e;color:#e8ecf7;padding:48px\">" +
        (err || !code
          ? "<h2>Granola sign-in failed</h2><p>" + (err || "No authorization code returned") + "</p>"
          : "<h2>Granola connected</h2><p>You can close this tab and return to the terminal.</p>") +
        "</body>");
      clearTimeout(timer);
      server.close();
      if (err) return reject(new Error("Authorization denied: " + err));
      if (!code) return reject(new Error("No authorization code returned"));
      if (state !== expectedState) return reject(new Error("State mismatch - possible interference; aborted"));
      resolve(code);
    });
    const timer = setTimeout(() => { server.close(); reject(new Error("Timed out waiting for browser sign-in")); }, timeoutMs);
    server.on("error", reject);
    server.listen(REDIRECT_PORT, "127.0.0.1");
  });
}

function openBrowser(url) {
  try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref(); }
  catch { /* the user can open it manually */ }
}

// ---------- authorization-code + PKCE login ----------
export async function granolaLogin(onPrompt = console.log) {
  let auth = loadAuth() || {};
  if (!auth.client_id || auth.redirect_uri !== REDIRECT_URI) {
    const reg = await registerClient();
    auth.client_id = reg.client_id;
    auth.redirect_uri = REDIRECT_URI;
    if (reg.client_secret) auth.client_secret = reg.client_secret;
    saveAuth(auth);
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authUrl = AS + "/oauth2/authorize?" + new URLSearchParams({
    response_type: "code",
    client_id: auth.client_id,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  // Start listening before opening the browser, so a fast redirect is never missed.
  const waiting = awaitRedirect(state);

  onPrompt("");
  onPrompt("  Opening your browser to sign in to Granola.");
  onPrompt("  If it does not open, paste this URL:");
  onPrompt("");
  onPrompt("    " + authUrl);
  onPrompt("");
  openBrowser(authUrl);

  const code = await waiting;

  const tBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: auth.client_id,
    code_verifier: verifier,
  });
  if (auth.client_secret) tBody.set("client_secret", auth.client_secret);

  const tRes = await fetch(AS + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tBody,
  });
  const t = await tRes.json().catch(() => ({}));
  if (!tRes.ok || !t.access_token) {
    throw new Error("Token exchange failed: " + (t.error_description || t.error || "HTTP " + tRes.status));
  }

  auth = {
    ...auth,
    access_token: t.access_token,
    refresh_token: t.refresh_token || auth.refresh_token,
    expires_at: Date.now() + (t.expires_in || 3600) * 1000 - 60000,
    scope: t.scope || SCOPES,
  };
  saveAuth(auth);
  onPrompt("  Signed in." + (auth.refresh_token
    ? " Refresh token stored, so scheduled runs keep working without you."
    : " NOTE: no refresh token was issued, so you may need to sign in again periodically."));
  return auth;
}

async function refresh(auth) {
  if (!auth.refresh_token) { const e = new Error("Granola session expired and there is no refresh token."); e.auth = true; throw e; }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
    client_id: auth.client_id,
  });
  if (auth.client_secret) body.set("client_secret", auth.client_secret);

  const res = await fetch(AS + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) { const e = new Error("Granola token refresh failed (HTTP " + res.status + "). Sign in again."); e.auth = true; throw e; }
  const t = await res.json();
  const next = {
    ...auth,
    access_token: t.access_token,
    refresh_token: t.refresh_token || auth.refresh_token,
    expires_at: Date.now() + (t.expires_in || 3600) * 1000 - 60000,
  };
  saveAuth(next);
  return next;
}

async function accessToken() {
  let auth = loadAuth();
  if (!auth || !auth.access_token) { const e = new Error("Granola is not linked. Run: node cc.mjs granola-login"); e.auth = true; throw e; }
  if (auth.expires_at && Date.now() > auth.expires_at) auth = await refresh(auth);
  return auth.access_token;
}

// ---------- MCP transport (Streamable HTTP, JSON-RPC 2.0) ----------
let sessionId = null;
let rpcId = 0;

// The server may answer either as plain JSON or as an SSE stream; handle both.
async function parseMcpResponse(res) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    let out = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try { const j = JSON.parse(payload); if (j.result || j.error) out = j; } catch {}
    }
    if (!out) throw new Error("No JSON-RPC payload in MCP stream");
    return out;
  }
  try { return JSON.parse(text); } catch { throw new Error("Unparseable MCP response: " + text.slice(0, 200)); }
}

async function rpc(method, params, { notification = false } = {}) {
  const token = await accessToken();
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer " + token,
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["MCP-Session-Id"] = sessionId;

  const body = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: ++rpcId, method, params };

  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (res.status === 401) { const e = new Error("Granola rejected the token. Run: node cc.mjs granola-login"); e.auth = true; throw e; }
  if (notification) return null;
  if (!res.ok) throw new Error("MCP HTTP " + res.status + ": " + (await res.text()).slice(0, 300));

  const json = await parseMcpResponse(res);
  if (json.error) {
    const e = new Error(json.error.message || JSON.stringify(json.error));
    if (/unauthor|token|expired/i.test(e.message)) e.auth = true;
    throw e;
  }
  return json.result;
}

async function ensureSession() {
  if (sessionId) return;
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "personal-command-center", version: "1.0.0" },
  });
  try { await rpc("notifications/initialized", {}, { notification: true }); } catch {}
}

export async function listTools() {
  await ensureSession();
  const r = await rpc("tools/list", {});
  return (r.tools || []).map((t) => ({ name: t.name, description: t.description }));
}

async function callTool(name, args) {
  await ensureSession();
  const r = await rpc("tools/call", { name, arguments: args });
  const parts = (r.content || []).filter((c) => c.type === "text").map((c) => c.text);
  const text = parts.join("\n");
  // Tools return JSON in a text block; fall back to raw text when it is prose.
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}

export async function getAccountInfo() {
  const { json, text } = await callTool("get_account_info", {});
  return json || { raw: text };
}

export async function listMeetings(sinceISO, limit = 50) {
  const attempts = [
    { limit, updated_after: sinceISO },
    { limit, since: sinceISO },
    { limit },
  ];
  let lastErr = null;
  for (const args of attempts) {
    try {
      const { json, text } = await callTool("list_meetings", args);
      return { meetings: normalizeMeetings(json), raw: text };
    } catch (e) { lastErr = e; if (e.auth) throw e; }
  }
  throw lastErr || new Error("list_meetings failed");
}

// Paid-plan tools. Both degrade to null rather than failing a run, so a plan change
// or a scope restriction never takes the whole collection down.
export async function getMeetingTranscript(id) {
  const attempts = [{ meeting_id: id }, { id }, { document_id: id }];
  for (const args of attempts) {
    try {
      const { json, text } = await callTool("get_meeting_transcript", args);
      if (json) {
        const t = json.transcript || json.text || json.content || json.segments || json;
        if (Array.isArray(t)) {
          return t.map((s) => (typeof s === "string" ? s
            : ((s.speaker || s.speaker_name || "") + ": " + (s.text || s.content || "")).trim())).join("\n");
        }
        if (typeof t === "string") return t;
      }
      if (text && text.trim()) return text;
    } catch (e) { if (e.auth) throw e; }
  }
  return null;
}

export async function listMeetingFolders() {
  try {
    const { json, text } = await callTool("list_meeting_folders", {});
    const arr = Array.isArray(json) ? json : (json && (json.folders || json.items || json.data)) || [];
    if (Array.isArray(arr) && arr.length) {
      return arr.map((f) => ({ id: f.id || f.folder_id || "", name: f.name || f.title || "" }));
    }
    return text && text.trim() ? [{ id: "", name: text.trim().slice(0, 120) }] : [];
  } catch (e) { if (e.auth) throw e; return null; }
}

export async function getMeetings(ids) {
  const attempts = [{ meeting_ids: ids }, { ids }, { document_ids: ids }];
  let lastErr = null;
  for (const args of attempts) {
    try {
      const { json, text } = await callTool("get_meetings", args);
      return { meetings: normalizeMeetings(json), raw: text };
    } catch (e) { lastErr = e; if (e.auth) throw e; }
  }
  throw lastErr || new Error("get_meetings failed");
}

// Tolerate several plausible response shapes rather than hard-coding one.
function normalizeMeetings(json) {
  if (!json) return [];
  const arr = Array.isArray(json) ? json
    : json.meetings || json.documents || json.results || json.items || json.data || [];
  if (!Array.isArray(arr)) return [];
  return arr.map((m) => ({
    id: m.id || m.meeting_id || m.document_id || m.uuid || "",
    title: m.title || m.name || m.subject || "Untitled meeting",
    when: m.start_time || m.started_at || m.created_at || m.date || m.updated_at || null,
    updated: m.updated_at || m.modified_at || m.created_at || null,
    attendees: (m.attendees || m.participants || [])
      .map((p) => (typeof p === "string" ? p : p.name || p.email || "")).filter(Boolean),
    notes: m.notes || m.summary || m.content || m.ai_summary || m.markdown || m.text || "",
    url: m.url || m.link || "",
  })).filter((m) => m.id);
}

export { MCP_URL, AUTH_PATH };
