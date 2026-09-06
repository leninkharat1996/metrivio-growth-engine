/**
 * Deterministic opt-out intent classification (Stage 6C, Section E).
 * No LLM. Conservative by explicit instruction: only clear, unambiguous
 * requests for no further contact qualify — ordinary rejection ("not
 * interested", "no thanks", "not right now") must NEVER be treated as an
 * opt-out on its own, only as `conversations.classification =
 * 'NOT_INTERESTED'` territory (a different, already-existing enum value
 * this module does not touch). Every pattern below is a whole-phrase,
 * case-insensitive match — never a bare keyword substring — mirroring the
 * same false-positive discipline already established for
 * `founder-classifier.ts`'s `EXECUTION_ONLY_QUALIFIER` and
 * `paid-media-job-posting.ts`'s title/hiring-language matches.
 */

export interface OptOutClassification {
  isOptOut: boolean;
  matchedPhrase: string | null;
  reason: string;
}

// Each pattern requires an explicit "stop contacting me" style phrase —
// not a single word ("stop", "remove") in isolation, which would be far
// too broad (e.g. "this will stop working" or "remove the old logo").
const OPT_OUT_PATTERNS: RegExp[] = [
  /\b(?:please\s+)?stop\s+(?:contacting|messaging|emailing|texting)\s+me\b/i,
  /\bdo(?:n'?t| not)\s+contact\s+me\b/i,
  /\bdo(?:n'?t| not)\s+message\s+me\b/i,
  /\bdo(?:n'?t| not)\s+email\s+me\b/i,
  /\bremove\s+me\s+from\s+(?:your|this|the)\s+(?:list|mailing list)\b/i,
  /\btake\s+me\s+off\s+(?:your|this|the)\s+list\b/i,
  /\bunsubscribe\b/i,
  /\bnot\s+interested,?\s*(?:please\s+)?don'?t\s+follow\s*up\b/i,
  /\bleave\s+me\s+alone\b/i,
  /\bno\s+more\s+messages(?:,?\s*please)?\b/i,
  /\bstop\s+messaging\b/i,
];

export function classifyOptOutIntent(text: string | null | undefined): OptOutClassification {
  const value = text ?? '';
  if (!value.trim()) {
    return { isOptOut: false, matchedPhrase: null, reason: 'empty message text' };
  }
  for (const pattern of OPT_OUT_PATTERNS) {
    const match = value.match(pattern);
    if (match) {
      return { isOptOut: true, matchedPhrase: match[0], reason: `matched explicit no-further-contact phrase: "${match[0]}"` };
    }
  }
  return { isOptOut: false, matchedPhrase: null, reason: 'no explicit no-further-contact phrase found — ordinary rejection is never treated as opt-out on its own' };
}
