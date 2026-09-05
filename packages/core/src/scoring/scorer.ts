import {
  ICP_FACTOR_WEIGHTS,
  ICP_EVIDENCE_TIER_MULTIPLIERS,
  ICP_SCORING_ENGINE_VERSION,
  tierForScore,
  type IcpEvidenceTier,
  type IcpFactorName,
  type DisclosureStatus,
} from './constants.js';
import type { IcpScoreResult } from './types.js';

/**
 * The deterministic Metrivio ICP Scoring Engine — docs/02-metrivio-icp.md
 * §22, transcribed exactly, as a pure function with no I/O (BUILD_PLAN.md
 * Stage 3). No LLM call, no randomness, no external API: the same input
 * always produces the same output.
 *
 * This module does not fetch or interpret raw `evidence` rows itself — that
 * translation is `evidence-normalization.ts`. This module only takes an
 * already-evaluated, structured `IcpScoringInput` and computes points/tiers/
 * bands from it, so the scoring math itself stays trivially auditable
 * against the ICP document's own worked examples (§22.F).
 */

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * ICP §22.A signal categories for Revenue-Fit (Company Scale Signal).
 *
 * `twoOrMorePaidAcquisitionCategoriesPresent` (signal 4, "2 or more Paid
 * Acquisition Activity/Intensity Fit signal categories are independently
 * present") is deliberately an EXPLICIT input here, not auto-derived from
 * `paidAcquisition`'s own category count, despite that being what the ICP
 * document's §22.A text literally describes. Auto-deriving it directly
 * contradicts the document's own §22.F worked example: the C-Tier example
 * (score 63) states Paid Acquisition has 2 categories present (Meta +
 * Google, → STRONG EVIDENCE) in the very same scenario where Revenue-Fit is
 * stated to have only 1 category (Shopify Plus, → LIKELY) — if signal 4
 * were applied automatically there, Revenue-Fit would have 2 categories and
 * land on STRONG EVIDENCE (20 pts, not the documented 10), breaking the
 * documented total of 63. This is a genuine internal contradiction in the
 * finalized ICP document between §22.A's rule text and its own §22.F
 * example, reported in the Stage 3 completion report rather than silently
 * resolved. Keeping this signal explicit (instead of hard-coded to
 * auto-derive) lets the exact §22.F golden totals be reproduced precisely,
 * as instructed, without baking a specific resolution of that contradiction
 * into the scorer itself.
 */
export interface RevenueFitEvidence {
  /** Signal 1: employee count (LinkedIn company page or equivalent) falls within ~5-75 employees. */
  employeeCountBandMatch: boolean;
  /** Signal 2: Shopify Plus tier detected (vs. standard Shopify). */
  shopifyPlusDetected: boolean;
  /** Signal 3: warehouse/fulfillment job postings or public references indicating physical scale. */
  warehouseFulfillmentSignal: boolean;
  /** Signal 4 — see the interface doc comment above for why this is explicit rather than derived. */
  twoOrMorePaidAcquisitionCategoriesPresent: boolean;
  /** CONFIRMED tier only: a primary source directly states the actual revenue figure. */
  confirmedRevenueStatement: boolean;
}

/** ICP §22.A signal categories for Paid Acquisition Activity/Intensity Fit. */
export interface PaidAcquisitionEvidence {
  /** Signal 1: Meta Ad Library shows at least one active ad within the last 30 days. */
  metaAdActiveLast30Days: boolean;
  /** Signal 2: Google Search/Shopping ads visibly active for brand and/or category terms. */
  googleAdsActive: boolean;
  /** Signal 3: a paid-media-specific job posting (media buyer, growth marketer, paid social specialist) posted within the last 90 days. */
  paidMediaJobPostingLast90Days: boolean;
  /** Signal 4: the company is publicly named as a client in a paid-media agency's case study or client list. */
  namedAgencyClient: boolean;
  /** CONFIRMED tier only: a primary source explicitly states a spend figure ≥$15k/month. Active ad presence alone must never set this true. */
  confirmedSpendStatement: boolean;
}

/** ICP §22.B Marketing/Ecommerce Maturity checklist (15 max, no evidence tiers). */
export interface MaturityEvidence {
  /** 2+ concurrent paid channels detected -> 5 pts. */
  twoOrMoreConcurrentPaidChannels: boolean;
  /** 2+ retention/ecommerce tools detected from {Klaviyo, Recharge, Yotpo, Gorgias} -> 5 pts (1 tool = 0; threshold fixed at 2). */
  twoOrMoreRetentionToolsDetected: boolean;
  /** At least one of {GA4, GTM, Meta Pixel} detected on-site -> 3 pts. */
  analyticsTagDetected: boolean;
  /** 2+ distinct product categories/lines evident in the catalog -> 2 pts. */
  twoOrMoreProductLines: boolean;
}

/** ICP §22.B Decision-Maker role check point tiers (fixed, mutually exclusive). */
export type DecisionMakerRoleTier =
  | 'founder_or_ceo' // Founder/Co-founder/CEO/Owner -> 8 pts
  | 'director_with_authority_signal' // VP/Head/Director of Marketing or Growth *with* a corroborating authority signal -> 6 pts
  | 'other_marketing_adjacent' // any other marketing-adjacent title, no corroborating authority signal -> 3 pts
  | 'execution_only'; // Specialist/Coordinator/Assistant/Associate -> 0 pts

/** ICP §22.B Decision-Maker Involvement/Contactability checklist (15 max, no evidence tiers). */
export interface DecisionMakerEvidence {
  roleTier: DecisionMakerRoleTier;
  /** Decision-maker has visible public activity (posts, press quotes) about the business -> 4 pts. */
  publicVisibility: boolean;
  /** Correct target decision-maker profile identified (name, current role, current employer all confirmed) -> 3 pts. Email availability is not required. */
  correctProfileIdentified: boolean;
}

/**
 * ICP §22.B Buying/Trigger Signal (15 max). `verifiedTriggerCount` is the
 * count of triggers that have already passed verification — sourced with a
 * specific URL, and (per the ICP document) never an implied "ad volume
 * increase" claim without two dated observations. That verification is
 * evidence-normalization's job (see evidence-normalization.ts); this pure
 * engine only applies the fixed count->points table.
 */
export interface TriggerEvidence {
  verifiedTriggerCount: number;
}

/** ICP §22.B DTC/Business Model Fit (5 max, no evidence tiers). */
export interface DtcFitEvidence {
  /** Confirmed DTC/ecommerce model with owned acquisition funnel -> 5 pts. Anything else (that didn't already trigger exclusion) -> 0 pts. */
  confirmedDtcWithOwnedFunnel: boolean;
}

/** ICP §15 Exclusion Criteria — checked first, overrides all positive scoring. */
export interface ExclusionEvidence {
  /** Not DTC/ecommerce (pure B2B, pure service business, pure wholesale). */
  notDtcEcommerce: boolean;
  /** No detectable paid acquisition activity of any kind. */
  noPaidAcquisitionActivityDetected: boolean;
  /** Company appears defunct, store non-functional, or no activity in the last 6+ months. */
  companyAppearsDefunct: boolean;
  /** Only contactable person found has no plausible budget authority. */
  onlyContactHasNoBudgetAuthority: boolean;
}

export interface IcpScoringInput {
  exclusions: ExclusionEvidence;
  revenueFit: RevenueFitEvidence;
  paidAcquisition: PaidAcquisitionEvidence;
  maturity: MaturityEvidence;
  decisionMaker: DecisionMakerEvidence;
  trigger: TriggerEvidence;
  dtcFit: DtcFitEvidence;
}

// ---------------------------------------------------------------------------
// Exclusions (ICP §15 / §22 intro: "checked first and override scoring")
// ---------------------------------------------------------------------------

const EXCLUSION_REASONS: Array<{ check: (e: ExclusionEvidence) => boolean; reason: string }> = [
  { check: (e) => e.notDtcEcommerce, reason: 'Not DTC/ecommerce (pure B2B, pure service business, or pure wholesale).' },
  { check: (e) => e.noPaidAcquisitionActivityDetected, reason: 'No detectable paid acquisition activity of any kind.' },
  {
    check: (e) => e.companyAppearsDefunct,
    reason: 'Company appears defunct, store non-functional, or no activity in the last 6+ months.',
  },
  {
    check: (e) => e.onlyContactHasNoBudgetAuthority,
    reason: 'Only contactable person found has no plausible budget authority.',
  },
];

/** Returns the first matching exclusion reason, or undefined if none apply. ICP §15 lists these as independent triggers; any single match is sufficient. */
export function checkExclusion(exclusions: ExclusionEvidence): string | undefined {
  return EXCLUSION_REASONS.find(({ check }) => check(exclusions))?.reason;
}

// ---------------------------------------------------------------------------
// Evidence-tier factors (Revenue-Fit, Paid Acquisition) — ICP §22.A
// ---------------------------------------------------------------------------

function countPaidAcquisitionCategories(p: PaidAcquisitionEvidence): number {
  return [p.metaAdActiveLast30Days, p.googleAdsActive, p.paidMediaJobPostingLast90Days, p.namedAgencyClient].filter(
    Boolean
  ).length;
}

function countRevenueFitCategories(r: RevenueFitEvidence): number {
  return [
    r.employeeCountBandMatch,
    r.shopifyPlusDetected,
    r.warehouseFulfillmentSignal,
    r.twoOrMorePaidAcquisitionCategoriesPresent, // ICP §22.A Revenue-Fit signal 4 — see RevenueFitEvidence doc comment
  ].filter(Boolean).length;
}

/**
 * ICP §22.A corroboration rule, fixed and identical for both evidence-tier
 * factors: CONFIRMED short-circuits everything (a primary source stating
 * the actual figure); otherwise tier is determined solely by counting
 * present signal categories. STRONG EVIDENCE can never be upgraded to
 * CONFIRMED by corroboration.
 */
function tierFromCategoryCount(categoryCount: number, confirmed: boolean): IcpEvidenceTier {
  if (confirmed) return 'CONFIRMED';
  if (categoryCount >= 2) return 'STRONG_EVIDENCE';
  if (categoryCount === 1) return 'LIKELY';
  return 'UNKNOWN';
}

/** ICP §22.D: disclosure status is derived directly from the same tier already computed — not a separate, potentially-contradictory input. */
function disclosureStatusForTier(tier: IcpEvidenceTier): DisclosureStatus {
  if (tier === 'CONFIRMED') return 'CONFIRMED';
  if (tier === 'UNKNOWN') return 'UNKNOWN';
  return 'NOT_CONFIRMED'; // STRONG_EVIDENCE or LIKELY: indirect evidence exists, no primary-source figure
}

function pointsForTier(maxPoints: number, tier: IcpEvidenceTier): number {
  return maxPoints * ICP_EVIDENCE_TIER_MULTIPLIERS[tier];
}

// ---------------------------------------------------------------------------
// Checklist factors (no evidence tiers) — ICP §22.B
// ---------------------------------------------------------------------------

function maturityPoints(m: MaturityEvidence): number {
  let points = 0;
  if (m.twoOrMoreConcurrentPaidChannels) points += 5;
  if (m.twoOrMoreRetentionToolsDetected) points += 5;
  if (m.analyticsTagDetected) points += 3;
  if (m.twoOrMoreProductLines) points += 2;
  return points;
}

const DECISION_MAKER_ROLE_POINTS: Record<DecisionMakerRoleTier, number> = {
  founder_or_ceo: 8,
  director_with_authority_signal: 6,
  other_marketing_adjacent: 3,
  execution_only: 0,
};

function decisionMakerPoints(d: DecisionMakerEvidence): number {
  let points = DECISION_MAKER_ROLE_POINTS[d.roleTier];
  if (d.publicVisibility) points += 4;
  if (d.correctProfileIdentified) points += 3;
  return points;
}

/** ICP §22.B: 0 verified triggers -> 0 pts; exactly 1 -> 10 pts; 2 or more -> 15 pts. */
function triggerPoints(t: TriggerEvidence): number {
  const count = Math.max(0, Math.trunc(t.verifiedTriggerCount));
  if (count >= 2) return 15;
  if (count === 1) return 10;
  return 0;
}

function dtcFitPoints(d: DtcFitEvidence): number {
  return d.confirmedDtcWithOwnedFunnel ? 5 : 0;
}

// ---------------------------------------------------------------------------
// Recommended action text — never a bare number (ARCHITECTURE.md §3.4)
// ---------------------------------------------------------------------------

function recommendedAction(exclusionReason: string | undefined, tier: IcpScoreResult['tier']): string {
  if (exclusionReason) return `Reject (exclusion): ${exclusionReason}`;
  switch (tier) {
    case 'A':
      return 'Highest priority — proceed to personalization and outreach.';
    case 'B':
      return 'Good prospect — queue for outreach.';
    case 'C':
      return 'Low priority — outreach optional, revisit if higher-priority queue is empty.';
    case 'Reject':
      return 'Reject (score below 60) — insufficient qualifying evidence.';
  }
}

// ---------------------------------------------------------------------------
// The scorer
// ---------------------------------------------------------------------------

/**
 * Computes the full deterministic ICP score for one prospect's evidence.
 * Exclusions (ICP §15) are checked first and, on a match, short-circuit the
 * score to `null` and the tier to `Reject` — per the document, "no score
 * calculated." The full factor breakdown is still computed and returned
 * even when excluded, purely for auditability/explainability (instruction:
 * "every scored criterion should be explainable" / "avoid opaque scoring")
 * — this does not change the outcome, since `score` stays `null` and `tier`
 * stays `Reject` regardless of what the breakdown shows.
 */
export function scoreProspect(input: IcpScoringInput): IcpScoreResult {
  const exclusionReason = checkExclusion(input.exclusions);

  const paidAcquisitionCategoryCount = countPaidAcquisitionCategories(input.paidAcquisition);
  const revenueFitCategoryCount = countRevenueFitCategories(input.revenueFit);

  const revenueFitTier = tierFromCategoryCount(revenueFitCategoryCount, input.revenueFit.confirmedRevenueStatement);
  const paidAcquisitionTier = tierFromCategoryCount(
    paidAcquisitionCategoryCount,
    input.paidAcquisition.confirmedSpendStatement
  );

  const revenueFitPts = pointsForTier(ICP_FACTOR_WEIGHTS.revenueFit, revenueFitTier);
  const paidAcquisitionPts = pointsForTier(ICP_FACTOR_WEIGHTS.paidAcquisition, paidAcquisitionTier);
  const maturityPts = maturityPoints(input.maturity);
  const decisionMakerPts = decisionMakerPoints(input.decisionMaker);
  const triggerPts = triggerPoints(input.trigger);
  const dtcFitPts = dtcFitPoints(input.dtcFit);

  const factorBreakdown: IcpScoreResult['factorBreakdown'] = {
    revenueFit: { points: revenueFitPts, maxPoints: ICP_FACTOR_WEIGHTS.revenueFit, evidenceTier: revenueFitTier },
    paidAcquisition: {
      points: paidAcquisitionPts,
      maxPoints: ICP_FACTOR_WEIGHTS.paidAcquisition,
      evidenceTier: paidAcquisitionTier,
    },
    maturity: { points: maturityPts, maxPoints: ICP_FACTOR_WEIGHTS.maturity },
    decisionMaker: { points: decisionMakerPts, maxPoints: ICP_FACTOR_WEIGHTS.decisionMaker },
    trigger: { points: triggerPts, maxPoints: ICP_FACTOR_WEIGHTS.trigger },
    dtcFit: { points: dtcFitPts, maxPoints: ICP_FACTOR_WEIGHTS.dtcFit },
  };

  const totalScore = revenueFitPts + paidAcquisitionPts + maturityPts + decisionMakerPts + triggerPts + dtcFitPts;

  const missingEvidence: IcpFactorName[] = (['revenueFit', 'paidAcquisition'] as const).filter(
    (name) => factorBreakdown[name].evidenceTier === 'UNKNOWN'
  );

  const score = exclusionReason ? null : totalScore;
  const tier = exclusionReason ? 'Reject' : tierForScore(totalScore);

  return {
    score,
    tier,
    exclusionTriggered: Boolean(exclusionReason),
    exclusionReason,
    factorBreakdown,
    revenueDisclosureStatus: disclosureStatusForTier(revenueFitTier),
    spendDisclosureStatus: disclosureStatusForTier(paidAcquisitionTier),
    missingEvidence,
    recommendedAction: recommendedAction(exclusionReason, tier),
    scoringEngineVersion: ICP_SCORING_ENGINE_VERSION,
  };
}
