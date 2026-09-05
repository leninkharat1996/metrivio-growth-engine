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
  /**
   * Only `revenueFit` and `paidAcquisition` actually use an evidence tier
   * (ICP §22.A: "applies to Revenue-Fit and Paid Acquisition Activity/
   * Intensity Fit only"). The other four factors are fixed-point checklists
   * with no tier concept at all (§22.B), so this is optional and correctly
   * absent for them — a Stage 3 correction to this Stage-1-authored type,
   * which had required it on every factor; see the Stage 3 completion
   * report for why forcing a fabricated tier onto checklist factors would
   * have been actively misleading rather than a scoring-rule change.
   */
  evidenceTier?: IcpEvidenceTier;
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
