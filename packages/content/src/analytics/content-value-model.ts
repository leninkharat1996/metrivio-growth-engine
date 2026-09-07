/**
 * Stage 9, Section H — the deterministic content-value model. Pure
 * function, no I/O, mirrors `content-scoring.ts`'s exact discipline
 * (Stage 7): documented fixed weights, never an AI-generated number.
 *
 * The four sub-scores are deliberately weighted so raw reach can NEVER
 * dominate (Section H/Critical Principle: "do not let raw views
 * dominate"). Business intent and ICP engagement — the two signals that
 * most directly indicate a qualified prospect noticed the content — carry
 * the most weight; reach carries the least.
 *
 *   Business Intent Score : 40
 *   ICP Score              : 30
 *   Engagement Score       : 20
 *   Reach Score            : 10
 *
 * Any sub-score whose underlying data is unavailable is excluded from
 * BOTH the numerator and the denominator of the final weighted average —
 * it is never treated as zero (Section H: "if evidence is insufficient,
 * return UNKNOWN or INSUFFICIENT_DATA"; the Critical Principle's own
 * "never silently convert missing to zero" rule, restated for scoring
 * specifically). If every sub-score is unavailable, the overall
 * classification is `UNKNOWN`, not a fabricated default.
 */
export const CONTENT_VALUE_WEIGHTS = {
  businessIntent: 40,
  icp: 30,
  engagement: 20,
  reach: 10,
} as const;

export const CONTENT_VALUE_CLASSIFICATIONS = ['HIGH_VALUE', 'MODERATE_VALUE', 'LOW_VALUE', 'UNKNOWN'] as const;
export type ContentValueClassification = (typeof CONTENT_VALUE_CLASSIFICATIONS)[number];

/** Overall-score cutoffs, on the 0-100 weighted-average scale. Documented here, not buried in a conditional. */
const HIGH_VALUE_THRESHOLD = 70;
const MODERATE_VALUE_THRESHOLD = 40;

export interface ContentValueInput {
  /** 0-100, or null if reach is unavailable (e.g. no impressions figure). Caller normalizes; this model does not know what "good reach" means in absolute terms. */
  reachScore: number | null;
  /** 0-100, or null if engagement rate could not be computed (no reach denominator, or no engagement data at all). */
  engagementScore: number | null;
  /** 0-100 — e.g. (icpEngagementCount / totalEngagers) * 100, or null if engager identities were never resolved. */
  icpScore: number | null;
  /** 0-100 — e.g. share of engagements classified GENUINE_INTENT, or null if no text-bearing engagement was ever collected. */
  businessIntentScore: number | null;
}

export interface ContentValueResult {
  reachScore: number | null;
  engagementScore: number | null;
  icpScore: number | null;
  businessIntentScore: number | null;
  overallScore: number | null;
  classification: ContentValueClassification;
  reason: string;
}

export function scoreContentValue(input: ContentValueInput): ContentValueResult {
  const components: Array<{ score: number | null; weight: number }> = [
    { score: input.businessIntentScore, weight: CONTENT_VALUE_WEIGHTS.businessIntent },
    { score: input.icpScore, weight: CONTENT_VALUE_WEIGHTS.icp },
    { score: input.engagementScore, weight: CONTENT_VALUE_WEIGHTS.engagement },
    { score: input.reachScore, weight: CONTENT_VALUE_WEIGHTS.reach },
  ];

  const available = components.filter((c) => c.score != null) as Array<{ score: number; weight: number }>;
  if (available.length === 0) {
    return {
      reachScore: null,
      engagementScore: null,
      icpScore: null,
      businessIntentScore: null,
      overallScore: null,
      classification: 'UNKNOWN',
      reason: 'no reach, engagement, ICP, or business-intent data is available for this post',
    };
  }

  const totalWeight = available.reduce((sum, c) => sum + c.weight, 0);
  const weightedSum = available.reduce((sum, c) => sum + c.score * c.weight, 0);
  const overallScore = Math.round(weightedSum / totalWeight);

  const classification: ContentValueClassification = overallScore >= HIGH_VALUE_THRESHOLD ? 'HIGH_VALUE' : overallScore >= MODERATE_VALUE_THRESHOLD ? 'MODERATE_VALUE' : 'LOW_VALUE';

  return {
    reachScore: input.reachScore,
    engagementScore: input.engagementScore,
    icpScore: input.icpScore,
    businessIntentScore: input.businessIntentScore,
    overallScore,
    classification,
    reason: `weighted average of ${available.length}/${components.length} available sub-score(s) (missing components excluded from both numerator and denominator, never treated as zero)`,
  };
}
