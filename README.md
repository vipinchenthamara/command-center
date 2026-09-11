# Command Center

A private, local-first work cockpit. It reads the tools you already use, extracts the
things that actually need you, and shows your day as a timeline instead of a backlog.

**Your data never leaves the machine.** The database, the exported notes and every
credential are gitignored. This repository is the skeleton — you plug in your own
accounts and it fills itself in.

```
┌ 09:12  NEXT · Weekly Progress · T-1h 48m ┐  ┌ SOURCES ─────────────┐
│                                          │  │ ● OUTLOOK   ONLINE   │
│  ●─ now                                  │  │ ● CALENDAR  ONLINE   │
│  11:00  Daily connect                    │  │ ● GRANOLA   ONLINE   │
│  ┄┄ focus window 11:30–15:00 ┄┄          │  │ ○ MONDAY    OFFLINE  │
│  15:00  Weekly Progress            ⚠     │  └──────────────────────┘
│     PREP · 10 open since last time       │  ┌ COMMITTED ───────────┐
│       YOU OWE  Send the deliverables     │  │ ① Send deliverables  │
│       ALEX     Server list → support     │  │ ② Excel tracker      │
│  18:00  Standup                          │  │ ③ slot open          │
└──────────────────────────────────────────┘  └──────────────────────┘
```

---

## Quick start

```
git clone <your-repo-url> command-center
cd command-center
npm install
node cc.mjs setup      # shows what is wired up and what is missing
node cc.mjs collect    # first collection
node cc.mjs serve      # dashboard on http://127.0.0.1:7777/
```

`setup` prints a checklist. Fill in `identity.email` and `identity.name` in
`data/config.json` (created on first run — see `config.example.json` for every option),
then re-run. Nothing else is mandatory: with no API keys at all, it still reads Outlook
and extracts with deterministic rules, fully offline.

| Command | What it does |
| --- | --- |
| `node cc.mjs setup` | First-run checklist: what is connected, what is missing |
| `node cc.mjs serve` | Start the dashboard |
| `node cc.mjs collect` | Run one collection now |
| `node cc.mjs status` | Source coverage and open counts |
| `node cc.mjs granola-key grn_…` | Store a Granola API key |
| `node acceptance.mjs` | Run the correctness checks against your own data |

Keyboard: `c` capture, `r` sync, `Esc` close panel.

---

## What plugs in

| Source | How it connects | Needs |
| --- | --- | --- |
| **Outlook mail** | Local COM via PowerShell | Classic Outlook desktop, running. No app registration, no tokens, no browser. Reading does **not** mark mail as read. |
| **Outlook calendar** | Same COM surface | Nothing extra. Teams meetings appear here, so Teams meeting data needs no scraper. |
| **Granola** | Official public API | `node cc.mjs granola-key grn_…` (Business/Enterprise plan). OAuth via MCP is implemented as a fallback. |
| **monday.com** | GraphQL, read-only | `MONDAY_API_TOKEN` |
| **Teams messages** | — | Not implemented, deliberately. See below. |
| **AI extraction** | Claude API | `ANTHROPIC_API_KEY`. Optional — rules-based extraction runs without it. |

> **Windows only, for now.** Outlook mail and calendar go through COM, which does not
> exist on macOS or Linux. The rest of the system is portable; `setup` will tell you.

### Why Teams messages are not implemented

Teams has no local COM surface. The only route that avoids registering an app is a
signed-in browser profile driven by Playwright — unvalidated against any given tenant,
and potentially against your organisation's acceptable-use policy.

Rather than ship a scraper that quietly returns nothing, the Teams source reports
`not configured` and the briefing says so. **An empty result is never presented as
"Teams was quiet."** That principle applies to every source.

---

## Adding your own tool

The connector layer is a registry. To plug in something new — Jira, Linear, Notion,
Slack, a CSV drop folder — you write one file and add one line.

**1. Write `src/connectors/yourtool.mjs`:**

```js
import { db, hash, newId, nowISO, getSource } from "../db.mjs";

export async function collectYourTool(cfg) {
  const c = cfg.yourtool || {};
  if (!c.enabled || !c.apiToken) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  // Resume from the last verified checkpoint, minus a deliberate overlap so
  // edits and late arrivals get re-examined.
  const src = getSource("yourtool");
  const since = src?.checkpoint
    ? new Date(new Date(src.checkpoint).getTime() - cfg.overlapHours * 3600000)
    : new Date(Date.now() - cfg.lookbackDays * 86400000);

  const items = await fetchFromYourTool(c.apiToken, since);

  const ins = db.prepare(
    `INSERT INTO raw_items(id,source,source_id,hash,payload,occurred_at,collected_at,processed)
     VALUES (?,?,?,?,?,?,?,0)
     ON CONFLICT(source,source_id) DO UPDATE SET
       hash=excluded.hash, payload=excluded.payload, collected_at=excluded.collected_at,
       processed=CASE WHEN raw_items.hash=excluded.hash THEN raw_items.processed ELSE 0 END`);

  for (const it of items) {
    // The hash is what makes re-collection replay-safe: an unchanged item is
    // never re-extracted and never produces a new revision.
    ins.run(newId(), "yourtool", it.id, hash(JSON.stringify(it)),
      JSON.stringify(it), it.updatedAt, nowISO());
  }

  return {
    ok: true,
    items: items.length,
    complete: true,                    // false if you know you did not see everything
    scope: items.length + " item(s) since " + since.toISOString().slice(0, 10),
  };
}
```

**2. Register it** in `src/connectors/index.mjs`:

```js
{ name: "yourtool", label: "Your Tool", collect: collectYourTool, selfReports: false }
```

That is enough for it to run on every collection, get a coverage row, and appear in the
source rail. To turn its payloads into records, add an `extractFromYourTool()` in
`src/extract/rules.mjs` and a case in `src/pipeline.mjs`.

**The one rule that matters:** return `complete: false` when you did not see everything —
a page limit, a rate limit, a partial load. That flag is what stops the briefing claiming
coverage it never had.

---

## How it works

```
Outlook mail ─┐
Outlook cal  ─┤
Granola      ─┼─→ raw_items ──→ extraction ──→ reconciliation ──→ SQLite ─┬─→ cockpit
monday.com   ─┤   (hashed,      (rules or      (stable identity,  (canon)  └─→ Obsidian
your tool    ─┘   replay-safe)   Claude)        field ownership)               (export)
```

**SQLite is the authority. The Obsidian vault is a one-way rendered export**, rebuilt
every run — delete the whole folder and nothing is lost.

Guarantees, each covered by `acceptance.mjs`:

- **Replay-safe** — re-collecting unchanged data creates no records and no revisions.
- **Your edits win** — every field you touch is marked yours; imports never overwrite it.
- **Renames are safe** — identity is anchored on the source item and its verbatim
  evidence quote, never on the title.
- **Dismissals stick** — the same unchanged evidence will not resurrect a dismissed item.
- **Stale edits are rejected** — saving against an out-of-date revision returns a conflict.
- **Degraded is never shown as fine** — a partial source says so, in words, not just colour.

### The cockpit

Organised around the day, not the backlog. It deliberately never shows a total open
count — that number is a debt meter, not an instrument. Instead:

- **The day spine** — meetings in order, with the gaps between them as focus windows.
- **Meeting prep** — for a recurring meeting, what is still open from last time and what
  you owe the people who will be in the room, assembled from prior notes and attendees.
- **Committed** — three slots. Not a list you drown in; a commitment you can finish.
- **Inbound** — what arrived since the last sync, and which mail actually needs a reply
  (judged on whether *you already replied in that thread*, not on whether it is unread).

The full backlog lives on the `ARCHIVE` page, where totals are fine because you went
looking for them.

---

## Security

- Bound to `127.0.0.1`. Mutations need a per-process token plus an Origin/Host check.
- CSP restricts the page to same-origin resources.
- Credentials live in `data/` (gitignored), never in `config.json`, never in the vault,
  and are masked by the config endpoint. Environment variables override the files, so no
  key has to touch disk.
- Only bounded evidence is stored — a quote and its context, not a mailbox mirror.
- Collected text is treated as untrusted data. The AI prompt states that instructions
  found inside collected content are recorded, never obeyed.

---

## Layout

```
cc.mjs                    CLI entry
src/db.mjs                schema + store
src/config.mjs            config, env overrides
src/pipeline.mjs          collect → extract → reconcile (single writer)
src/reconcile.mjs         stable identity, field ownership
src/cockpit.mjs           day assembly, meeting prep, inbox triage
src/brief.mjs             priority scoring with explainable reasons
src/vault.mjs             Obsidian export
src/server.mjs            local HTTP API
src/connectors/index.mjs  ← register new tools here
src/extract/rules.mjs     deterministic extraction, no network
src/extract/ai.mjs        Claude extraction, structured outputs
src/web/                  cockpit + archive
data/                     your database, config, credentials (gitignored)
vault/                    rendered export (gitignored)
```

Keep the folder out of OneDrive or Dropbox — a live SQLite file and a syncing client
do not mix.

---

## Scheduling

```
powershell -ExecutionPolicy Bypass -File .\setup-autostart.ps1   # server at logon
powershell -ExecutionPolicy Bypass -File .\setup-schedule.ps1 -Time 07:30
```

The morning task wakes the laptop and runs once if the window was missed. It does not
pretend to collect while the machine is off. Both are removable with `-Remove`.

---

## Licence

MIT — see `LICENSE`.
