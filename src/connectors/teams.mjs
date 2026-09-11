// Teams. Deliberately NOT implemented as a live scraper yet.
//
// Unlike Outlook, Teams has no local COM surface, so the only route meeting the
// "no app registration" constraint is a signed-in browser profile driven by Playwright.
// That is unvalidated on this tenant and may conflict with Conditional Access or
// acceptable-use policy. It therefore reports not_configured rather than returning an
// empty result that a briefing could misread as "nothing happened in Teams".
import { updateSource } from '../db.mjs';

export async function collectTeams(cfg) {
  if (!(cfg.teams && cfg.teams.enabled)) {
    updateSource('teams', {
      enabled: 0, last_status: 'not_configured', coverage_complete: 0,
      last_error: "Not enabled. Needs a Playwright browser profile signed in to your tenant, plus confirmation that automated browser access is permitted by your organisation policy.",
      scope_note: 'No Teams coverage. Briefings state this rather than implying Teams was quiet.',
    });
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  updateSource('teams', {
    enabled: 1, last_status: 'error', coverage_complete: 0,
    last_error: 'Enabled in config but the browser runtime is not installed. Run: npm i playwright && npx playwright install msedge',
  });
  return { ok: false, error: 'teams_runtime_missing' };
}
