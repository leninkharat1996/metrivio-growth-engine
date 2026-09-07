/**
 * Stage 8, Section P — the verified X platform text-length constraint.
 *
 * This is deliberately NOT folded into Stage 7's `validateContentDraft`
 * (`../drafts/content-validation.ts`): that function's existing rule set
 * governs draft-authoring-time quality checks (fabricated-stat/case-study
 * guards) and is exercised by Stage 7's own regression tests as an
 * unchanged, stable contract. This module is a separate, additive,
 * publish-time-only constraint, applied by `PublishApprovedContentService`
 * immediately before calling `XPublishAdapter` — never during ordinary
 * draft generation/approval, so Stage 7's existing behavior and tests are
 * untouched.
 *
 * The 280-weighted-character limit and the "a URL always counts as 23
 * characters" rule are copied from the verified upstream source
 * (`packages/adapters/vendor/x-manager-http/VENDOR.md`'s "Character limit"
 * section, itself citing X's own public counting-characters documentation:
 * https://developer.x.com/en/docs/counting-characters). This is X's own
 * platform standard for OAuth1 user-context posts — not invented here.
 */

export const MAX_X_POST_WEIGHTED_LENGTH = 280;

const X_URL_WEIGHT = 23;
const URL_PATTERN = /https?:\/\/[^\s)}\]]+/g;

/** Twitter/X-weighted character count: every http(s) URL counts as exactly 23 characters regardless of its real length. */
export function xWeightedLength(text: string): number {
  let length = text.length;
  for (const match of text.matchAll(URL_PATTERN)) {
    length += X_URL_WEIGHT - match[0].length;
  }
  return length;
}

export interface XPostConstraintCheck {
  withinLimit: boolean;
  weightedLength: number;
  maxWeightedLength: number;
}

export function checkXPostConstraints(text: string): XPostConstraintCheck {
  const weightedLength = xWeightedLength(text);
  return {
    withinLimit: weightedLength <= MAX_X_POST_WEIGHTED_LENGTH,
    weightedLength,
    maxWeightedLength: MAX_X_POST_WEIGHTED_LENGTH,
  };
}
