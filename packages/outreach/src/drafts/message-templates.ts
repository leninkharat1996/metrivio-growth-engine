import type { PersonalizationCandidate } from '../personalization/personalization-candidates.js';

/**
 * Deterministic message-draft templates (Stage 6A, Section F). No LLM is
 * used or required — every branch below is a fixed string template with
 * simple, safe interpolation (a first name, a company name). The
 * architecture leaves room for a future LLM personalization adapter (a
 * different implementation of the same "produce message text from a
 * candidate" responsibility), but per instruction, an LLM must never
 * become the source of truth for a factual claim — this module already
 * enforces that boundary for the deterministic path by never splicing a
 * `rawValue` (the literal scraped text) into the rendered message. A hook's
 * `observation` is always re-phrased through one of the fixed category
 * templates below, never inserted verbatim — this also sidesteps any risk
 * of a scraped snippet producing a grammatically broken or misleading
 * sentence once dropped into a template.
 */

export function firstNameFrom(displayName: string | null | undefined): string {
  const trimmed = (displayName ?? '').trim();
  if (!trimmed) return 'there';
  const first = trimmed.split(/\s+/)[0];
  return first && first.length > 0 ? first : 'there';
}

function greeting(displayName: string | null | undefined): string {
  return `Hi ${firstNameFrom(displayName)},`;
}

/**
 * Renders message text for one selected candidate (or none). Every branch
 * is a category-level paraphrase (instruction D/E) — no dollar figures, no
 * ROAS/CAC numbers, no headcount numbers, no verbatim scraped text, even
 * when the underlying candidate is `safeToStateAsFact: true`. A human
 * reviewer who wants to add a specific confirmed figure can still edit the
 * draft before approving it — this template system's job is to produce a
 * safe, defensible starting point, not a finished, unreviewable message.
 */
export function renderMessageDraft(displayName: string | null | undefined, companyName: string | null, candidate: PersonalizationCandidate | null): string {
  const hi = greeting(displayName);
  const company = companyName ?? 'your company';

  if (!candidate) {
    return `${hi} wanted to reach out — following your work at ${company}.`;
  }

  switch (candidate.hookType) {
    case 'role_company':
      return `${hi} saw you're leading things at ${company} — always interested in connecting with people building in the DTC/ecommerce space.`;
    case 'website_technology':
      return `${hi} noticed ${company}'s stack while looking into the space — curious how attribution's set up across it.`;
    case 'pain_intent':
      return `${hi} came across something you posted that resonated — sounds like you're thinking hard about acquisition performance right now.`;
    case 'business_trigger':
      return `${hi} saw the recent news about ${company} — exciting stage to be scaling through.`;
    case 'acquisition_signal':
      return `${hi} noticed ${company} running paid acquisition — curious how attribution's been holding up as you scale it.`;
    default: {
      const exhaustive: never = candidate.hookType;
      return exhaustive;
    }
  }
}
