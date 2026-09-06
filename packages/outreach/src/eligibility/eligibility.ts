/**
 * Outreach eligibility (BUILD_PLAN.md "Stage 8 — Outreach Engine", scoped
 * here to Stage 6A's foundation only). A pure, deterministic evaluator —
 * see `eligibility-service.ts` for the I/O layer that gathers its inputs
 * from the database.
 *
 * Core design principle (non-negotiable, per this stage's instructions):
 * scoring and outreach are separate questions.
 *   - Stage 3's `scoreProspect()` answers "is this prospect a good ICP fit?"
 *   - `evaluateOutreachEligibility()` answers "is this prospect currently
 *     eligible to receive outreach?" — it reads the *result* of Stage 3
 *     scoring (a tier) as one input among several, but never recomputes,
 *     reinterprets, or overrides it. Nothing here touches
 *     `packages/core/src/scoring/`.
 */

export const OUTREACH_ELIGIBILITY_STATUSES = [
  'ELIGIBLE',
  'INELIGIBLE',
  'BLOCKED',
  'ALREADY_CONTACTED',
  'AWAITING_REPLY',
  'STOPPED',
  'UNKNOWN',
] as const;
export type OutreachEligibilityStatus = (typeof OUTREACH_ELIGIBILITY_STATUSES)[number];

export interface OutreachEligibilityResult {
  status: OutreachEligibilityStatus;
  /** Human-readable, auditable explanation of exactly which check produced this status. */
  reason: string;
}

/** Mirrors `prospects.outreach_status` (DATABASE.md/schema.ts) exactly — never redefined here. */
export type ProspectOutreachStatus =
  | 'not_started'
  | 'queued'
  | 'active_sequence'
  | 'replied'
  | 'stopped_opted_out'
  | 'stopped_not_interested'
  | 'stopped_disqualified'
  | 'stopped_manual'
  | 'converted';

/** Mirrors the subset of `icp_scores` (Stage 3, unmodified) this evaluator needs. */
export interface LatestIcpScoreInput {
  tier: 'A' | 'B' | 'C' | 'Reject';
  exclusionTriggered: boolean;
}

/** Mirrors the subset of `conversations` (DATABASE.md §2) this evaluator needs. */
export interface LatestConversationInput {
  state: 'active' | 'stopped';
  classification: 'POSITIVE' | 'INTERESTED' | 'QUESTION' | 'NEUTRAL' | 'NOT_INTERESTED' | 'OPT_OUT' | 'SPAM' | 'UNKNOWN';
  lastMessageDirection: 'outbound' | 'inbound' | null;
}

export interface OutreachEligibilityInput {
  outreachStatus: ProspectOutreachStatus;
  /** `null` when no `icp_scores` row exists yet for this prospect — distinct from a row that exists with a low tier. */
  latestIcpScore: LatestIcpScoreInput | null;
  /** `null` when no `conversations` row exists yet for this prospect. */
  latestConversation: LatestConversationInput | null;
  /** Whether at least one `evidence`/`pain_signals` row exists for this prospect — used only for the "missing required evidence" check, never to re-derive scoring. */
  hasAnyEvidence: boolean;
  killSwitchActive: boolean;
  /** From `SystemConfigService.getOutreachMinimumTier()` — `null` means "not configured" (Section B: no ICP/offer document defines this threshold). */
  outreachMinimumTier: 'A' | 'B' | 'C' | null;
}

const TERMINAL_STOPPED_STATUSES = new Set<ProspectOutreachStatus>([
  'stopped_opted_out',
  'stopped_not_interested',
  'stopped_disqualified',
  'stopped_manual',
]);

const ALREADY_ENGAGED_STATUSES = new Set<ProspectOutreachStatus>(['queued', 'active_sequence', 'replied', 'converted']);

/** ICP §22.C band ranking, for comparison against the configured threshold only — never a re-derivation of how a tier was computed. */
const TIER_RANK: Record<'A' | 'B' | 'C' | 'Reject', number> = { Reject: -1, C: 1, B: 2, A: 3 };

/**
 * Pure function: same input always produces the same output (instruction
 * L). Checks are ordered most-definitive-first — a stopped/opted-out
 * prospect is never reclassified as merely "ineligible," and the kill
 * switch is checked before any prospect-specific reasoning, mirroring
 * `KillSwitch`'s own "always wins" precedence (ARCHITECTURE.md §7).
 */
export function evaluateOutreachEligibility(input: OutreachEligibilityInput): OutreachEligibilityResult {
  if (TERMINAL_STOPPED_STATUSES.has(input.outreachStatus)) {
    return { status: 'STOPPED', reason: `prospect.outreach_status is "${input.outreachStatus}" — a terminal stop/opt-out state` };
  }
  if (input.latestConversation && (input.latestConversation.classification === 'OPT_OUT' || input.latestConversation.classification === 'NOT_INTERESTED')) {
    return { status: 'STOPPED', reason: `the prospect's conversation is classified "${input.latestConversation.classification}"` };
  }

  if (input.killSwitchActive) {
    return { status: 'BLOCKED', reason: 'the kill switch is active — this overrides every other outreach determination' };
  }

  if (input.latestConversation && input.latestConversation.state === 'active' && input.latestConversation.lastMessageDirection === 'outbound') {
    return { status: 'AWAITING_REPLY', reason: 'an active conversation exists and the last message was outbound — waiting to hear back' };
  }

  if (ALREADY_ENGAGED_STATUSES.has(input.outreachStatus)) {
    return { status: 'ALREADY_CONTACTED', reason: `prospect.outreach_status is "${input.outreachStatus}" — already contacted or in an active sequence` };
  }

  if (!input.latestIcpScore) {
    return { status: 'UNKNOWN', reason: 'no icp_scores row exists yet for this prospect — fit cannot be determined' };
  }

  if (input.latestIcpScore.exclusionTriggered || input.latestIcpScore.tier === 'Reject') {
    return { status: 'INELIGIBLE', reason: 'the latest ICP score triggered an exclusion (or is tier Reject) — Stage 3\'s own determination, not re-evaluated here' };
  }

  if (input.outreachMinimumTier === null) {
    return {
      status: 'INELIGIBLE',
      reason: 'no outreach score threshold is configured (system_config "outreach.minimum_tier") — neither the ICP nor the offer document defines one, so this is left as an explicit, unresolved configuration decision rather than an invented default',
    };
  }

  if (TIER_RANK[input.latestIcpScore.tier] < TIER_RANK[input.outreachMinimumTier]) {
    return {
      status: 'INELIGIBLE',
      reason: `tier "${input.latestIcpScore.tier}" is below the configured outreach minimum tier "${input.outreachMinimumTier}"`,
    };
  }

  if (!input.hasAnyEvidence) {
    return { status: 'INELIGIBLE', reason: 'no evidence exists for this prospect — insufficient basis for personalized outreach' };
  }

  return { status: 'ELIGIBLE', reason: 'passes all outreach eligibility checks: not stopped, not blocked, not already engaged, ICP tier meets the configured threshold, evidence exists' };
}
