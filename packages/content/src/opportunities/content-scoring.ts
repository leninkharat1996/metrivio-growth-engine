import type { ContentConfidenceLevel } from '../confidence.js';

/**
 * Stage 7, Section V — the deterministic content-opportunity score. Pure
 * function, no I/O, no AI-generated numbers: every dimension below is a
 * documented, fixed weight applied to a documented, fixed saturation
 * point. Weights sum to exactly 100.
 *
 *  - ICP relevance      (30): how many ICP-sourced signals actually
 *    discuss this pain category — the single most important dimension,
 *    since a topic with zero direct ICP evidence should never outrank one
 *    with real ICP evidence, regardless of everything else (Section E:
 *    "a viral post from people outside the ICP should not outrank...").
 *  - Differentiation    (25): inverse of how many DISTINCT competitor
 *    accounts already cover this category — a category no competitor
 *    touches is a bigger opportunity than one everyone already covers.
 *  - Frequency/pain intensity (15): total signal volume across all
 *    sources (ICP + competitor + expert + web) touching this category.
 *  - Recency            (15): exponential decay from the most recent
 *    relevant signal's date — a topic that has gone quiet still counts,
 *    just less.
 *  - Evidence strength  (15): the proportion of higher-confidence signals
 *    (FACT/OBSERVATION) versus lower-confidence ones (INFERENCE/OPINION).
 *
 * Every "saturation point" below is where a dimension reaches its full
 * weight — going further doesn't add more score, deliberately, so a
 * single outlier signal count can't dominate the result.
 */
export const CONTENT_SCORE_WEIGHTS = {
  icpRelevance: 30,
  differentiation: 25,
  frequency: 15,
  recency: 15,
  evidenceStrength: 15,
} as const;

const ICP_RELEVANCE_SATURATION = 5; // 5+ distinct ICP signals = full ICP-relevance credit
const FREQUENCY_SATURATION = 10; // 10+ total signals = full frequency credit
const DIFFERENTIATION_SATURATION = 3; // 3+ distinct competitor accounts already covering it = zero differentiation credit
const RECENCY_HALF_LIFE_DAYS = 14; // signal "freshness" halves every 14 days

/** A score is only computed when there is at least this much direct ICP evidence — otherwise `UNKNOWN` (Section V: "if the score is not sufficiently supported by available evidence, return UNKNOWN rather than pretending precision"). */
export const MIN_ICP_SIGNALS_FOR_SCORE = 1;

export interface ContentOpportunityScoreInput {
  icpSignalCount: number;
  totalSignalCount: number;
  competitorAccountCoverage: number;
  mostRecentSignalAt: string | null;
  confidenceCounts: Partial<Record<ContentConfidenceLevel, number>>;
  /** Injected for determinism/testability — never read from the system clock inside this pure function. */
  now: string;
}

export interface ContentOpportunityScoreBreakdown {
  icpRelevance: number;
  differentiation: number;
  frequency: number;
  recency: number;
  evidenceStrength: number;
}

export type ContentOpportunityScoreResult = { score: number; breakdown: ContentOpportunityScoreBreakdown; reason: string } | { score: null; breakdown: null; reason: string };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function scoreContentOpportunity(input: ContentOpportunityScoreInput): ContentOpportunityScoreResult {
  if (input.icpSignalCount < MIN_ICP_SIGNALS_FOR_SCORE) {
    return { score: null, breakdown: null, reason: `insufficient ICP evidence (${input.icpSignalCount} signal(s)) to score this opportunity — never scored from competitor/expert/web signals alone` };
  }

  const icpRelevance = clamp01(input.icpSignalCount / ICP_RELEVANCE_SATURATION) * CONTENT_SCORE_WEIGHTS.icpRelevance;
  const frequency = clamp01(input.totalSignalCount / FREQUENCY_SATURATION) * CONTENT_SCORE_WEIGHTS.frequency;
  const differentiation = (1 - clamp01(input.competitorAccountCoverage / DIFFERENTIATION_SATURATION)) * CONTENT_SCORE_WEIGHTS.differentiation;

  let recency = 0;
  if (input.mostRecentSignalAt) {
    const ageDays = Math.max(0, (new Date(input.now).getTime() - new Date(input.mostRecentSignalAt).getTime()) / (24 * 60 * 60 * 1000));
    recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS) * CONTENT_SCORE_WEIGHTS.recency;
  }

  const totalConfidenceSignals = Object.values(input.confidenceCounts).reduce((sum, n) => sum + (n ?? 0), 0);
  const strongConfidenceSignals = (input.confidenceCounts.FACT ?? 0) + (input.confidenceCounts.OBSERVATION ?? 0);
  const evidenceStrength = totalConfidenceSignals > 0 ? (strongConfidenceSignals / totalConfidenceSignals) * CONTENT_SCORE_WEIGHTS.evidenceStrength : 0;

  const score = Math.round(icpRelevance + frequency + differentiation + recency + evidenceStrength);

  return {
    score,
    breakdown: { icpRelevance: Math.round(icpRelevance), differentiation: Math.round(differentiation), frequency: Math.round(frequency), recency: Math.round(recency), evidenceStrength: Math.round(evidenceStrength) },
    reason: `scored from ${input.icpSignalCount} ICP signal(s), ${input.totalSignalCount} total signal(s), ${input.competitorAccountCoverage} competitor account(s) covering this topic`,
  };
}
