/**
 * Stage 7's confidence axis (source-hierarchy instructions: "clearly
 * distinguish FACT / OBSERVATION / INFERENCE / OPINION. Never convert
 * inference into fact."). Deliberately distinct from `evidence.evidence_tier`
 * (CONFIRMED/STRONG_EVIDENCE/LIKELY/UNKNOWN, Stage 3) — that axis grades how
 * verifiable a prospect-targeting claim is; this one grades how directly a
 * content-research claim is grounded in its source:
 *
 *  - FACT: a directly quoted, sourced, verifiable statement (e.g. a
 *    first-party statistic from a cited report, a verbatim quote from a
 *    public post with its URL).
 *  - OBSERVATION: something directly observed in a public source without
 *    interpretation (e.g. "this account posted about X on this date").
 *  - INFERENCE: a conclusion drawn from one or more observations (e.g.
 *    "this competitor appears to be de-emphasizing case studies" from a
 *    pattern across several posts).
 *  - OPINION: a judgment call, including this system's own strategic
 *    recommendations — never presented as a fact.
 */
export const CONTENT_CONFIDENCE_LEVELS = ['FACT', 'OBSERVATION', 'INFERENCE', 'OPINION'] as const;
export type ContentConfidenceLevel = (typeof CONTENT_CONFIDENCE_LEVELS)[number];

export function isContentConfidenceLevel(value: unknown): value is ContentConfidenceLevel {
  return typeof value === 'string' && (CONTENT_CONFIDENCE_LEVELS as readonly string[]).includes(value);
}
