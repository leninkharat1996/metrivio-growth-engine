/**
 * Stage 9, Section G — deterministic business-intent classification over a
 * single piece of reply/mention text. Never an LLM judgment call, and
 * never promotes a generic positive reaction ("love this", "🔥", "so
 * true") to business intent — Section G's explicit instruction ("do not
 * classify generic likes as business intent") extended here to generic
 * *replies* too, since a like carries no text to classify at all.
 *
 * `UNKNOWN` is reserved for the case where there is no text to evaluate at
 * all (e.g. a bare like/repost with no reply body) — NOT a fallback for
 * "text exists but isn't business intent," which is `GENERIC_ENGAGEMENT`.
 * This mirrors Section F's identity rule ("if it cannot be confidently
 * established, UNKNOWN") applied to intent instead of identity.
 */
export const BUSINESS_INTENT_LEVELS = ['GENUINE_INTENT', 'GENERIC_ENGAGEMENT', 'UNKNOWN'] as const;
export type BusinessIntentLevel = (typeof BUSINESS_INTENT_LEVELS)[number];

/** Section G's own named signal categories, each as a whole-phrase/word pattern — never a bare substring match that could false-positive on unrelated text. */
const GENUINE_INTENT_MARKERS: RegExp[] = [
  /\bmetrivio\b/i,
  /\b(your|this) (methodology|framework|approach|diagnostic)\b/i,
  /\bhow (does|do) (this|it|your (tool|product|diagnostic)) work\b/i,
  /\b(marketing|ad spend|spend) efficiency\b/i,
  /\bcan (you|i|we) (dm|message|talk|chat|hop on a call)\b/i,
  /\b(would love|interested) (to|in) (chat|talk|learn more|a demo)\b/i,
  /\b(can|could) you help\b/i,
  /\bfor my (store|brand|business|company)\b/i,
  /\bhow (would|does) this apply to (my|our)\b/i,
  /\bwhat would you (recommend|suggest) for\b/i,
];

export function classifyBusinessIntent(text: string | null | undefined): BusinessIntentLevel {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return 'UNKNOWN';
  if (GENUINE_INTENT_MARKERS.some((pattern) => pattern.test(trimmed))) return 'GENUINE_INTENT';
  return 'GENERIC_ENGAGEMENT';
}
