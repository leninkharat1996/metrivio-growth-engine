import { firstNameFrom } from '../drafts/message-templates.js';
import type { PersonalizationCandidate } from '../personalization/personalization-candidates.js';
import type { FollowUpIntent } from '../drafts/message-draft.js';

/**
 * Deterministic follow-up message templates (Stage 6D, Section E). No LLM
 * is used — every branch is a fixed string template, mirroring the
 * discipline `../drafts/message-templates.ts` already established for
 * original messages: a hook's `observation` is always re-phrased through a
 * fixed category clause, never spliced in as raw scraped text, and no
 * dollar figures/ROAS/CAC/headcount numbers are ever interpolated.
 *
 * Only three intents are implemented, per instruction — each guaranteed to
 * read differently from `renderMessageDraft`'s original-message output
 * (never "just following up" as the only value, never "I know you're
 * busy", never an invented business problem/metric/result).
 */

function newObservationClause(candidate: PersonalizationCandidate | null, companyName: string | null): string | null {
  if (!candidate) return null;
  const company = companyName ?? 'your company';
  switch (candidate.hookType) {
    case 'role_company':
      return `saw you're leading things at ${company}`;
    case 'website_technology':
      return `noticed ${company}'s stack while looking into the space`;
    case 'pain_intent':
      return 'came across something else you posted that stood out';
    case 'business_trigger':
      return `saw the recent news about ${company}`;
    case 'acquisition_signal':
      return `noticed ${company} running paid acquisition`;
    default: {
      const exhaustive: never = candidate.hookType;
      return exhaustive;
    }
  }
}

function greeting(displayName: string | null | undefined): string {
  return `Hi ${firstNameFrom(displayName)},`;
}

/**
 * Renders a follow-up's message text for one selected intent. `newHook`
 * is a personalization candidate the original message did NOT already
 * reference (Section D: "a new verified observation") — `null` when none
 * is available, in which case the reminder/clarification templates fall
 * back to a value-oriented clause that still never invents a fact.
 */
export function renderFollowUpMessageDraft(
  displayName: string | null | undefined,
  companyName: string | null,
  intent: FollowUpIntent,
  newHook: PersonalizationCandidate | null
): string {
  const hi = greeting(displayName);
  const observation = newObservationClause(newHook, companyName);

  switch (intent) {
    case 'clarification':
      return observation
        ? `${hi} circling back — ${observation}, and wanted to see if a quick chat on attribution/acquisition performance would be useful.`
        : `${hi} circling back on my last note — happy to share more specifics on how Metrivio approaches attribution if that would help.`;
    case 'reminder':
      return observation
        ? `${hi} one more thing worth flagging — ${observation}. Still happy to connect whenever it's useful.`
        : `${hi} wanted to bump this in case it got buried — still glad to connect if the timing works better now.`;
    case 'final_close':
      return `${hi} I'll leave this here for now — feel free to reach out any time if attribution/acquisition performance becomes a priority.`;
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}
