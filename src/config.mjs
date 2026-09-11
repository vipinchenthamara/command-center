import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './db.mjs';

const CONFIG_PATH = join(ROOT, 'data', 'config.json');

const DEFAULTS = {
  // Detected from the host, so a fresh clone is correct anywhere.
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  briefingTime: '07:30',
  workingDays: [1, 2, 3, 4, 5],
  identity: { email: '', name: '', aliases: [] },
  lookbackDays: 3,
  overlapHours: 12,
  outlook: { enabled: true, folders: ['inbox', 'sent'], maxItems: 400, bodyChars: 2500 },
  teams: { enabled: false, note: 'Requires Playwright browser sign-in. Not yet validated.' },
  granola: {
    enabled: false,
    cachePath: '',
    maxMeetings: 50,
    includeTranscripts: null,   // null = auto (on when AI extraction is enabled); true/false to force
    transcriptChars: 12000,
    note: 'Preferred: run "node cc.mjs granola-login". cachePath is only for the export-folder fallback.',
  },
  monday: { enabled: false, apiToken: '', boardIds: [], note: 'Read-only. Write-back is out of scope.' },
  ai: { enabled: false, apiKey: '', model: 'claude-sonnet-5', briefModel: 'claude-opus-5', maxItemsPerRun: 120 },
  vault: { enabled: true, path: join(ROOT, 'vault') },
  server: { port: 7777, host: '127.0.0.1' },
};

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  let user = {};
  if (existsSync(CONFIG_PATH)) {
    try { user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
    catch (e) { console.error('config.json is invalid, using defaults:', e.message); }
  }
  const cfg = deepMerge(DEFAULTS, user);
  // Env vars win, so secrets need never be written to disk.
  if (process.env.ANTHROPIC_API_KEY) { cfg.ai.apiKey = process.env.ANTHROPIC_API_KEY; cfg.ai.enabled = true; }
  if (process.env.MONDAY_API_TOKEN) { cfg.monday.apiToken = process.env.MONDAY_API_TOKEN; cfg.monday.enabled = true; }
  return cfg;
}

export function saveConfig(patch) {
  let user = {};
  if (existsSync(CONFIG_PATH)) { try { user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {} }
  const merged = deepMerge(user, patch);
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return loadConfig();
}

export function ensureConfig() {
  if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  return loadConfig();
}

export { CONFIG_PATH, DEFAULTS };
