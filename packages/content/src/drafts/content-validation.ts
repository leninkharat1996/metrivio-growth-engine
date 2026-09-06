/**
 * Stage 7, Section I/P — deterministic content-draft validation. NOT an
 * LLM: every rule is a fixed, documented pattern. A draft that matches any
 * rule is `flagged` (never silently rejected outright — a human reviewer
 * still makes the final call, consistent with this system's approval-first
 * philosophy) with an explicit note naming which rule fired, mirroring
 * `content_drafts.quality_check_notes`'s own documented purpose ("which
 * rule(s) flagged it — fabricated stat, implied case study, etc.").
 */
export const CONTENT_VALIDATION_STATUSES = ['pass', 'flagged'] as const;
export type ContentValidationStatus = (typeof CONTENT_VALIDATION_STATUSES)[number];

export interface ContentValidationResult {
  status: ContentValidationStatus;
  notes: string[];
}

const RULES: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /\$\s?\d/, note: 'contains a dollar figure — Metrivio has no verified client results to cite; verify this is not a fabricated figure' },
  { pattern: /\b\d+(\.\d+)?\s?%/, note: 'contains a percentage figure — verify this is traceable to real evidence, not invented' },
  { pattern: /\b\d+(\.\d+)?x\b/i, note: 'contains a multiplier figure (e.g. "3.5x ROAS") — verify this is traceable to real evidence, not invented' },
  { pattern: /(our client|our customers?|case stud|testimonial|success story|before[\s-]and[\s-]after)/i, note: 'references a client/case study — Metrivio currently has NO verified client case studies (Section N); this must never be implied' },
  { pattern: /\bwe (achieved|generated|delivered|grew|increased|reduced|helped \w+ (achieve|reach|grow))\b/i, note: 'claims a specific outcome Metrivio achieved — never state an unverified outcome as fact' },
];

/** A copied-content guard (Section P): flags a draft that contains a long verbatim substring from a stored research excerpt — research is for insight extraction, never content copying. */
const MIN_VERBATIM_MATCH_LENGTH = 40;

export function checkOriginality(body: string, sourceExcerpts: readonly string[]): { isOriginal: boolean; matchedExcerpt?: string } {
  for (const excerpt of sourceExcerpts) {
    if (excerpt.length < MIN_VERBATIM_MATCH_LENGTH) continue;
    if (body.includes(excerpt)) {
      return { isOriginal: false, matchedExcerpt: excerpt };
    }
  }
  return { isOriginal: true };
}

export function validateContentDraft(body: string, sourceExcerpts: readonly string[] = []): ContentValidationResult {
  const notes: string[] = [];

  for (const rule of RULES) {
    if (rule.pattern.test(body)) notes.push(rule.note);
  }

  const originality = checkOriginality(body, sourceExcerpts);
  if (!originality.isOriginal) {
    notes.push(`contains a verbatim excerpt from a research source — this must be rewritten as original insight, never copied (Section P)`);
  }

  return { status: notes.length > 0 ? 'flagged' : 'pass', notes };
}
