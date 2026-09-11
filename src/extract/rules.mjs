// Deterministic extraction. Runs with no API key and no network.
// Conservative by design: prefers surfacing a clarification over inventing an owner.

const BULK_SENDER = /(no-?reply|donotreply|newsletter|marketing|notifications?@|mailer|updates?@|info@|hello@|team@|news@|digest|via\s)/i;
const BULK_BODY = /(unsubscribe|manage (your )?preferences|view (this|in) browser|privacy policy|you (are )?receiv(ed|ing) this (email|message)|update your preferences|opt out)/i;
const AUTOMATED = /(build (failed|succeeded)|jenkins|pipeline #|automated (message|report)|scan (complete|report)|do not reply|delivery status notification)/i;

const REQUEST_PAT = [
  /\b(can|could|would) you\b/i,
  /\bplease (review|confirm|send|share|check|update|approve|provide|complete|advise|look|arrange|prepare)\b/i,
  /\b(need|require)s? (you|your) (to|input|approval|review|help|confirmation|sign-?off)\b/i,
  /\b(kindly|request you to)\b/i,
  /\bawait(ing)? your\b/i,
  /\b(let me know|get back to me|revert to me)\b/i,
  /\bassigned to you\b/i,
  /\baction (required|needed)\b/i,
  /\byour (input|approval|review|confirmation|sign-?off) (is|are)?\s*(required|needed)?\b/i,
];

// Contractions must require the apostrophe. An optional one made /\bwe.?ll\b/
// match the ordinary word "well", turning "hope you are doing well" into a commitment.
const COMMIT_PAT = [
  /\bI['’]ll\b/,
  /\bI will\b/,
  /\bI can (do|send|share|get|have|check|review|arrange)\b/i,
  /\bwe['’]ll\b/i,
  /\bwe will\b/i,
  /\bI['’]m going to\b/,
  /\blet me (check|confirm|get|look|send|review)\b/i,
  /\bI['’]ve (started|begun|picked up)\b/,
  /\bwill (send|share|revert|update|complete|do|prepare) (this|that|it|by|the)\b/i,
];

const BLOCKER_PAT = [
  /\bblock(ed|er|ing)\b/i,
  /\bstuck (on|with)\b/i,
  /\bcan['’]t proceed\b/i,
  /\bcannot proceed\b/i,
  /\b(waiting|blocked) (on|for)\b/i,
  /\bfail(ed|ing|ure)\b/i,
  /\b(escalate|escalated|escalation|urgent|critical|outage)\b/i,
  /\bnot working\b/i,
  /\bat risk\b/i,
];

const DECISION_PAT = [
  /\bwe (have )?(decided|agreed|concluded)\b/i,
  /\bdecision (is|was|has been)\b/i,
  /\bagreed (that|to|on)\b/i,
  /\bsign(ed)?-?off\b/i,
  /\bapproved\b/i,
  /\bgoing (with|ahead with)\b/i,
  /\bfinali[sz]ed\b/i,
];

const DEADLINE_PAT = [
  /\bby (end of |EOD |EOW |COB )?(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bdue (on|by)\b/i,
  /\bdeadline\b/i,
  /\bbefore (the )?(meeting|call|eod|eow)\b/i,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i,
];

// Closing boilerplate that pattern-matches as a request but carries no actual ask.
const NOISE_PAT = [
  /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b/i,
  /\bhope (you|this) (are|is|find)\b/i,
  /^(thanks|thank you|regards|best regards|kind regards|warm regards|sincerely|cheers)\b/i,
  /\blet me know if you (have any|need any|require any)\b/i,
  /\bplease (do not|don['’]t) hesitate\b/i,
  /\bfeel free to (reach out|contact|ask)\b/i,
  /\b(looking forward|look forward) to\b/i,
  /\bthis (e-?mail|message) (and any|is) (attachments?|confidential|intended)\b/i,
  /\bplease consider the environment\b/i,
  /\bsent from my (iphone|ipad|android|mobile)\b/i,
  /\bwe (will be|would be|are) happy to (assist|help)\b/i,
  /\bwe appreciate your (understanding|patience)\b/i,
  /\bthank you for your (understanding|patience|cooperation)\b/i,
  /\bthere are always urgent projects\b/i,
  /\bplease let me know your suitable time\b/i,
];

// Structural fragments: document bullets and quoted mail headers. These match the
// intent patterns but are useless as standalone items, because the context that gave
// them meaning is the surrounding document, not the sentence.
const FRAGMENT_PAT = [
  /^#{1,6}\s/,          // markdown headings: section titles, not actions
  /^[*\-•·>]+\s/,
  /^\d+[.)]\s/,
  /^(subject|from|to|cc|bcc|sent|date|importance|attachments?)\s*:/i,
  /^(re|fw|fwd)\s*:/i,
  /^[[(]?(external|caution|warning)[\])]?\s*:/i,
];

// Vendor and event marketing whose sender address looks like a person.
const MARKETING_BODY = [
  /\b(register|sign up) (now|today|here)\b/i,
  /\b(book|schedule|request) a (demo|call|meeting|consultation)\b/i,
  /\b(webinar|whitepaper|e-?book|case study|free trial|exclusive offer)\b/i,
  /\b(join us|save your (seat|spot)|limited (seats|time)|rsvp)\b/i,
  /\bdownload the (report|guide|whitepaper)\b/i,
  /\bwhich of the following topics can you speak to\b/i,
];


const OOO_PAT = [
  /\b(out of (the )?office|automatic reply|auto-?reply|on (annual |medical |maternity )?leave)\b/i,
  /\blimited access to (email|e-mail)\b/i,
  /\bupon my return\b/i,
  /\bI am currently (away|unavailable|on leave)\b/i,
  /\bwill be back (in|on) the office\b/i,
  /\bfor urgent (matters|assistance)[, ].{0,40}(contact|reach)\b/i,
];

const isFragment = (s) => FRAGMENT_PAT.some((p) => p.test(s));
const isNoise = (s) => NOISE_PAT.some((p) => p.test(s)) || isFragment(s);

const any = (pats, s) => pats.some((p) => p.test(s));
const firstMatch = (pats, s) => {
  for (const p of pats) {
    const m = s.match(p);
    if (m) return m[0];
  }
  return null;
};

function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 12 && s.length < 400);
}

export function isBulk(item) {
  // The collector already tested the untruncated body for footer markers.
  if (item.bulkHint) return true;
  const from = String((item.senderEmail || "") + " " + (item.senderName || "")).toLowerCase();
  const body = item.body || "";
  if (BULK_SENDER.test(from)) return true;
  if (BULK_BODY.test(body)) return true;
  if (AUTOMATED.test(item.subject || "")) return true;
  // Two or more marketing cues in one body is a campaign, whatever the sender looks like.
  if (MARKETING_BODY.filter((p) => p.test(body)).length >= 2) return true;
  // Out-of-office replies read like commitments ("I will respond on my return") but
  // are not work. They are an absence notice, not a dependency to track.
  if (OOO_PAT.some((p) => p.test(item.subject || "") || p.test(body.slice(0, 600)))) return true;
  const recipients = String((item.to || "") + ";" + (item.cc || "")).split(/[;,]/).filter(Boolean).length;
  if (recipients > 15) return true;
  return false;
}

function isMe(cfg, addr) {
  const id = cfg.identity || {};
  const me = [id.email, id.name].concat(id.aliases || []).filter(Boolean).map((s) => String(s).toLowerCase());
  const a = String(addr || "").toLowerCase();
  return me.some((m) => m && a.includes(m));
}

// Candidate records for one email. Never fabricates a date or an owner.
export function extractFromEmail(item, cfg) {
  const out = [];
  if (isBulk(item)) return out;

  const outbound = item.direction === "outbound";
  const subject = String(item.subject || "(no subject)").trim();
  const sents = sentences(item.body);

  for (const s of sents.slice(0, 40)) {
    if (isNoise(s)) continue;
    let type = null;
    let confidence = 0.5;
    let note = "";

    if (outbound && any(COMMIT_PAT, s)) { type = "task"; confidence = 0.72; }
    else if (!outbound && any(REQUEST_PAT, s)) { type = "task"; confidence = 0.62; }
    else if (!outbound && any(COMMIT_PAT, s)) { type = "waiting"; confidence = 0.58; }
    else if (any(BLOCKER_PAT, s)) { type = "issue"; confidence = 0.55; }
    else if (any(DECISION_PAT, s)) { type = "decision"; confidence = 0.55; }
    if (!type) continue;

    // A request sent to a group, not explicitly to me, is a clarification -- not an assumed assignment.
    const groupSend = String(item.to || "").split(/[;,]/).filter(Boolean).length > 3;
    if (type === "task" && !outbound && groupSend && !isMe(cfg, item.to)) {
      type = "clarification";
      confidence = 0.4;
      note = "Addressed to several people; ownership is not explicit.";
    }

    out.push({
      type,
      title: s.length > 120 ? s.slice(0, 117) + "..." : s,
      detail: subject,
      owner: outbound ? (cfg.identity && cfg.identity.email) || "me" : item.senderName || "",
      project: "",
      confidence,
      needs_clarification: type === "clarification" ? 1 : 0,
      clarification_note: note,
      source_due_date: null,
      deadline_phrase: firstMatch(DEADLINE_PAT, s) || "",
      evidence: [{ quote: s, context: "Subject: " + subject, url: "" }],
    });
  }

  const seen = new Set();
  return out
    .filter((r) => {
      const k = r.type + "|" + r.title.toLowerCase().slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4);
}

export function extractFromMonday(item) {
  const status = String(item.status || "").toLowerCase();
  const blocked = /(block|stuck|hold|risk|overdue|critical)/.test(status);
  return [
    {
      type: "issue",
      title: item.title,
      detail: "Board: " + item.boardName + (item.status ? " - " + item.status : ""),
      owner: item.owner || "",
      project: item.boardName || "",
      confidence: 1.0,
      needs_clarification: 0,
      clarification_note: "",
      source_due_date: item.dueDate || null,
      external_issue_id: item.sourceId,
      priority: blocked ? 2 : 3,
      evidence: (item.updates || []).slice(0, 2).map((u) => ({
        quote: String(u.body).slice(0, 300),
        context: "Update by " + u.by,
        url: item.url || "",
      })),
    },
  ];
}

// Meeting bodies arrive as "## Summary", "## My notes", "## Transcript" sections.
// Transcript lines are speaker-prefixed, and the account owner's label is known, so a
// spoken "I'll send that over" becomes YOUR task while someone else saying it is a
// dependency you are waiting on. That distinction is the whole value of the transcript.
// Speech is full of hedges and disfluencies that make a line look like an action
// without carrying one. Strip the openers, drop fillers, and reject what is left if
// it is too short or too hedged to be a real commitment.
const FILLER_OPENER = /^((okay|ok|yeah|yep|so|well|right|alright|and|but|um|uh|i mean|you know|like|actually|basically)[,.]?\s+)+/i;
const HEDGE = /\b(maybe|perhaps|might|possibly|i guess|not sure|if this is something)\b/i;

function cleanSpoken(s) {
  let t = String(s).replace(FILLER_OPENER, "").trim();
  t = t.replace(/\b(uh|um|erm)\b[,]?\s*/gi, " ").replace(/\s+/g, " ").trim();
  if (t.length < 28) return null;              // too short to be a real commitment
  if (HEDGE.test(t)) return null;              // speculative, not a commitment
  if (!/[a-z]{3}/i.test(t)) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function splitSections(body) {
  const out = { summary: "", mine: "", transcript: "" };
  const parts = String(body || "").split(/^##\s+/m);
  for (const p of parts) {
    if (/^Summary\b/i.test(p)) out.summary = p.replace(/^Summary\s*/i, "");
    else if (/^My notes\b/i.test(p)) out.mine = p.replace(/^My notes\s*/i, "");
    else if (/^Transcript\b/i.test(p)) out.transcript = p.replace(/^Transcript\s*/i, "");
    else if (!out.summary) out.summary = p;
  }
  return out;
}

export function extractFromGranola(item) {
  const out = [];
  const meLabel = item.meLabel || "Me";
  const ctx = "Meeting: " + item.title;
  const url = item.url || item.path || "";
  const push = (type, text, confidence, owner, extra = {}) => {
    out.push({
      type,
      title: text.length > 120 ? text.slice(0, 117) + "..." : text,
      detail: ctx,
      owner: owner || "",
      project: "",
      confidence,
      needs_clarification: 0,
      clarification_note: "",
      source_due_date: null,
      evidence: [{ quote: text, context: ctx, url }],
      ...extra,
    });
  };

  const { summary, mine, transcript } = splitSections(item.body);

  // Granola summaries are markdown: headings plus bullets, and the bullets carry the
  // substance. Walk them heading-aware, because a bullet under "Next steps" is an action
  // while the same sentence under "Overview" is background.
  const ACTION_HEADING = /\b(next step|action item|follow[- ]?up|to-?do|owner|assignment|decision)s?\b/i;
  const RISK_HEADING = /\b(risk|issue|blocker|concern|gap|finding)s?\b/i;
  let heading = "";
  let pending = null;   // top-level bullet awaiting its indented detail lines

  const flushPending = () => {
    if (!pending) return;
    const { text, indentDetail, head } = pending;
    pending = null;
    const detail = indentDetail.join(" ").slice(0, 300);

    // "**Send the deliverables** (Alex)" -> owner Alex, title without the marker.
    let title = text;
    let owner = "";
    const om = title.match(/^(.*?)\s*\(([^()]{2,40})\)\s*$/);
    if (om && /^[A-Za-z][A-Za-z .'-]+$/.test(om[2])) { title = om[1].trim(); owner = om[2].trim(); }
    title = title.replace(/\*\*/g, "").replace(/^["'“]|["'”]$/g, "").trim();
    if (title.length < 12) return;

    const mineNow = !owner || owner.toLowerCase().includes(String(meLabel).toLowerCase().split(" ")[0]);
    const extra = detail ? { detail: ctx + " - " + detail } : {};

    if (ACTION_HEADING.test(head)) {
      const decision = any(DECISION_PAT, title) && !/^(send|prepare|schedule|raise|collect|pilot|clarify|list|automate|review|share|set up|follow)/i.test(title);
      if (decision) push("decision", title, 0.75, "", extra);
      // An action assigned to someone else is a dependency, not your to-do list.
      else if (owner && !mineNow) push("waiting", title, 0.8, owner, extra);
      else push("task", title, 0.82, owner || meLabel, extra);
    } else if (/\b(action item|todo|to-do|follow[- ]up|next step)s?\b/i.test(title)) {
      push("task", title, 0.75, owner || meLabel, extra);
    } else if (any(COMMIT_PAT, title)) {
      push(mineNow ? "task" : "waiting", title, 0.62, owner || meLabel, extra);
    } else if (any(DECISION_PAT, title)) {
      push("decision", title, 0.68, "", extra);
    } else if (RISK_HEADING.test(head) || any(BLOCKER_PAT, title)) {
      push("issue", title, RISK_HEADING.test(head) ? 0.65 : 0.6, "", extra);
    } else if (/\?\s*$/.test(title)) {
      push("discussion", title, 0.45, "", extra);
    }
  };

  for (const rawLine of String(summary + "\n" + mine).split(/\n/).slice(0, 500)) {
    if (!rawLine.trim()) continue;

    const h = rawLine.trim().match(/^#{1,6}\s+(.*)$/);
    if (h) { flushPending(); heading = h[1].trim(); continue; }

    const bullet = rawLine.match(/^(\s*)(?:[-*•·]|\d+[.)])\s+(.*)$/);
    if (!bullet) { flushPending(); continue; }

    const indent = bullet[1].length;
    const text = bullet[2].trim();
    if (!text) continue;
    // A bare link is metadata (Granola appends a transcript link), never an action.
    if (/^\[?https?:\/\//i.test(text) || /^chat with meeting transcript/i.test(text)) continue;
    if (NOISE_PAT.some((p) => p.test(text))) continue;

    if (indent > 0 && pending) {
      // Indented under a parent: supporting detail, not a separate commitment.
      pending.indentDetail.push(text.replace(/\*\*/g, ""));
      continue;
    }
    flushPending();
    if (text.length > 400) continue;
    pending = { text, indentDetail: [], head: heading };
  }
  flushPending();

  // Transcript: attribute commitments to whoever actually said them.
  const lines = String(transcript).split(/\n+/);
  for (const line of lines.slice(0, 400)) {
    const m = line.match(/^([^:]{1,40}):\s*(.+)$/);
    if (!m) continue;
    const speaker = m[1].trim();
    const said = m[2].trim();
    if (said.length < 18 || said.length > 400) continue;
    const isMine = speaker.toLowerCase() === meLabel.toLowerCase();

    for (const raw of sentences(said)) {
      const s = cleanSpoken(raw);
      if (!s || isNoise(s)) continue;
      if (any(COMMIT_PAT, s)) {
        // Spoken commitments are softer evidence than written ones.
        if (isMine) push("task", s, 0.6, meLabel);
        else push("waiting", s, 0.55, speaker);
      } else if (!isMine && any(REQUEST_PAT, s)) {
        push("task", s, 0.55, meLabel);
      } else if (any(BLOCKER_PAT, s)) {
        push("issue", s, 0.5, speaker);
      }
    }
  }

  const seen = new Set();
  return out
    .filter((r) => {
      const k = r.type + "|" + r.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
}
