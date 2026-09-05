/**
 * ICP Scoring Engine — boundary constants only.
 *
 * Per the founder's explicit instruction ("Do not weaken or change the
 * Metrivio ICP scoring rules") and ARCHITECTURE.md §3.4, these constants are
 * transcribed exactly from `docs/02-metrivio-icp.md` §22 and must never be
 * adjusted without that source document changing first.
 *
 * Stage 1 scope note: this module defines the fixed weights, evidence-tier
 * multipliers, and score bands as typed, tested constants — the "scoring
 * boundaries" the founder's Stage 1 instructions call for. It does NOT
 * implement the deterministic scoring algorithm itself (checklist-factor
 * point tables, exclusion checks, the full worked-example calculations).
 * That is Stage 3's job per BUILD_PLAN.md ("Implement the deterministic
 * scorer exactly per ICP document §22, as a pure function with no I/O"),
 * including the golden tests against ICP §22.F. Pulling the full algorithm
 * forward into Stage 1 was deliberately avoided so Stage 3 still has a clean,
 * dedicated, fully-tested implementation pass — this module exists so
 * nothing downstream in Stage 1 (types, adapters, config) has to guess at
 * these numbers or duplicate them.
 */

/** ICP §22 Factor Weights table. Must sum to 100 — enforced by a unit test. */
export const ICP_FACTOR_WEIGHTS = {
  revenueFit: 25,
  paidAcquisition: 25,
  maturity: 15,
  decisionMaker: 15,
  trigger: 15,
  dtcFit: 5,
} as const;

export type IcpFactorName = keyof typeof ICP_FACTOR_WEIGHTS;

/** ICP §22.A Evidence-Tier Table — multiplier applied to a factor's max points. */
export const ICP_EVIDENCE_TIER_MULTIPLIERS = {
  CONFIRMED: 1.0,
  STRONG_EVIDENCE: 0.8,
  LIKELY: 0.4,
  UNKNOWN: 0.0,
} as const;

export type IcpEvidenceTier = keyof typeof ICP_EVIDENCE_TIER_MULTIPLIERS;

/**
 * ICP §22.C Score Bands. Lower bounds are inclusive; a score below `Reject`'s
 * threshold (60) is a Reject. `A` has no upper bound beyond 100.
 */
export const ICP_SCORE_BANDS = {
  A: { min: 90, max: 100 },
  B: { min: 75, max: 89 },
  C: { min: 60, max: 74 },
  Reject: { min: 0, max: 59 },
} as const;

export type IcpTier = keyof typeof ICP_SCORE_BANDS;

/**
 * Given a numeric score (0-100), returns the tier per ICP §22.C. This is a
 * pure boundary lookup, not the scoring algorithm itself — it does not know
 * how to compute a score, only how to classify one that already exists.
 */
export function tierForScore(score: number): IcpTier {
  if (score >= ICP_SCORE_BANDS.A.min) return 'A';
  if (score >= ICP_SCORE_BANDS.B.min) return 'B';
  if (score >= ICP_SCORE_BANDS.C.min) return 'C';
  return 'Reject';
}

/** ICP §22.D Disclosure Status values — independent of the score itself. */
export const DISCLOSURE_STATUSES = ['CONFIRMED', 'NOT_CONFIRMED', 'UNKNOWN'] as const;
export type DisclosureStatus = (typeof DISCLOSURE_STATUSES)[number];
