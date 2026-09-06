import type { DecisionMakerRoleTier } from '@metrivio/core';

/**
 * Deterministic founder/CEO candidate classification (BUILD_PLAN.md Stage
 * 4B — "no LLM"). Reuses Stage 3's own `DecisionMakerRoleTier` vocabulary
 * (ICP §22.B) so the result vocabulary matches the scorer exactly, without
 * this classifier computing or implying any score itself — this is
 * candidate filtering/classification only.
 *
 * Deliberately conservative about false positives: an execution-only
 * qualifier ("assistant to the founder," "founder's coordinator") checked
 * first, and every match is a whole-word/phrase match, never a bare
 * substring, so a bio containing an unrelated word that happens to contain
 * "ceo"/"founder" as a substring cannot match.
 */

export interface FounderClassification {
  /** Whether any role phrase was found at all. `false` means UNKNOWN, not "not a founder." */
  roleDetected: boolean;
  /** The exact matched phrase from the bio, for auditability. `null` when nothing matched. */
  matchedPhrase: string | null;
  /** Stage 3's own role-tier vocabulary — `null` only when roleDetected is false. */
  normalizedRole: DecisionMakerRoleTier | null;
  /** Always 'bio' in Stage 4B — this classifier only ever looks at profile bio text. */
  source: 'bio';
  /**
   * Per ICP §4: a single indirect signal (a bio phrase, not independently
   * corroborated by e.g. press or a second account) is LIKELY, never higher.
   * `null` when roleDetected is false (no evidence tier for "no signal").
   */
  evidenceTier: 'LIKELY' | null;
}

const EXECUTION_ONLY_QUALIFIER =
  /\b(assistant|coordinator|specialist|associate)\b[^.!?\n]{0,25}\b(founder|co-founder|ceo|owner)\b|\b(founder|co-founder|ceo|owner)\b[^.!?\n]{0,25}\b(assistant|coordinator|specialist|associate)\b/i;

const FOUNDER_OR_CEO = /\b(co-founder|cofounder|founder|ceo|chief executive officer|owner)\b/i;

const DIRECTOR_WITH_TITLE =
  /\b(vp|vice president|head of|director)\b[^.!?\n]{0,30}\b(marketing|growth)\b/i;

const OTHER_MARKETING_ADJACENT =
  /\b(marketing manager|growth marketer|growth lead|marketer|media buyer|performance marketer)\b/i;

const EXECUTION_ONLY_TITLE = /\b(specialist|coordinator|assistant|associate)\b/i;

function firstMatch(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[0] : null;
}

export function classifyFounderCandidate(bio: string | undefined | null): FounderClassification {
  const text = bio ?? '';
  const unknown: FounderClassification = {
    roleDetected: false,
    matchedPhrase: null,
    normalizedRole: null,
    source: 'bio',
    evidenceTier: null,
  };
  if (!text.trim()) return unknown;

  // Disqualifying context checked first: "assistant to the founder" must
  // never classify as founder_or_ceo.
  const disqualified = firstMatch(text, EXECUTION_ONLY_QUALIFIER);
  if (disqualified) {
    return {
      roleDetected: true,
      matchedPhrase: disqualified,
      normalizedRole: 'execution_only',
      source: 'bio',
      evidenceTier: 'LIKELY',
    };
  }

  const founderMatch = firstMatch(text, FOUNDER_OR_CEO);
  if (founderMatch) {
    return { roleDetected: true, matchedPhrase: founderMatch, normalizedRole: 'founder_or_ceo', source: 'bio', evidenceTier: 'LIKELY' };
  }

  const directorMatch = firstMatch(text, DIRECTOR_WITH_TITLE);
  if (directorMatch) {
    return {
      roleDetected: true,
      matchedPhrase: directorMatch,
      normalizedRole: 'director_with_authority_signal',
      source: 'bio',
      evidenceTier: 'LIKELY',
    };
  }

  const otherMatch = firstMatch(text, OTHER_MARKETING_ADJACENT);
  if (otherMatch) {
    return {
      roleDetected: true,
      matchedPhrase: otherMatch,
      normalizedRole: 'other_marketing_adjacent',
      source: 'bio',
      evidenceTier: 'LIKELY',
    };
  }

  const executionMatch = firstMatch(text, EXECUTION_ONLY_TITLE);
  if (executionMatch) {
    return {
      roleDetected: true,
      matchedPhrase: executionMatch,
      normalizedRole: 'execution_only',
      source: 'bio',
      evidenceTier: 'LIKELY',
    };
  }

  // No role vocabulary found at all — genuinely unknown, not assumed
  // execution-only (ICP §4: "the Skill must not guess").
  return unknown;
}
