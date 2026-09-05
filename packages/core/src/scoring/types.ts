import type { IcpFactorName, IcpEvidenceTier, IcpTier, DisclosureStatus } from './constants.js';

/**
 * The shape every ICP score output must take, per ARCHITECTURE.md §3.4:
 * "never a bare number, matching the 'no black box' requirement." The full
 * computation that produces this shape is Stage 3 work; this type exists now
 * so DB persistence (icp_scores table) and dashboard code (Stage 7) can be
 * written against a stable contract without waiting on the scorer itself.
 */
export interface IcpFactorBreakdownEntry {
  points: number;
  maxPoints: number;
  evidenceTier: IcpEvidenceTier;
}

export interface IcpScoreResult {
  score: number | null; // null when exclusionTriggered
  tier: IcpTier;
  exclusionTriggered: boolean;
  exclusionReason?: string;
  factorBreakdown: Record<IcpFactorName, IcpFactorBreakdownEntry>;
  revenueDisclosureStatus: DisclosureStatus;
  spendDisclosureStatus: DisclosureStatus;
  missingEvidence: IcpFactorName[];
  recommendedAction: string;
  scoringEngineVersion: string;
}
