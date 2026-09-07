/**
 * Stage 9, Section E/H — deterministic CTA-shape classification. Mirrors
 * `hook-classifier.ts`'s exact discipline: this is a MECHANICS classifier
 * only (what kind of call-to-action shape a post ends with), never a
 * voice/personality judgment, and never an LLM. Used to group own-content
 * performance by CTA type (Section E) — a field `OwnPostMetricsInput` does
 * not otherwise carry.
 */
export const CTA_TYPES = ['reply_cta', 'follow_cta', 'link_cta', 'dm_cta', 'question_cta', 'none'] as const;
export type CtaType = (typeof CTA_TYPES)[number];

const REPLY_MARKERS = /\b(reply|comment|let me know|tell me|drop a|share your)\b/i;
const FOLLOW_MARKERS = /\b(follow (me|for|along)|hit follow)\b/i;
const LINK_MARKERS = /\b(link in bio|read more|full (post|breakdown|thread)|check (it|this) out|see the (thread|post))\b/i;
const DM_MARKERS = /\b(dm me|send me a (dm|message)|message me)\b/i;

/**
 * Order matters: an explicit reply/follow/link/DM ask is a more specific
 * signal than a bare trailing question mark, so those are checked first.
 * A trailing question with no other CTA marker is classified as a
 * `question_cta` (an implicit invitation to respond) rather than `none`.
 */
export function classifyCtaType(text: string): CtaType {
  const trimmed = text.trim();
  if (REPLY_MARKERS.test(trimmed)) return 'reply_cta';
  if (FOLLOW_MARKERS.test(trimmed)) return 'follow_cta';
  if (LINK_MARKERS.test(trimmed)) return 'link_cta';
  if (DM_MARKERS.test(trimmed)) return 'dm_cta';
  if (trimmed.endsWith('?')) return 'question_cta';
  return 'none';
}
