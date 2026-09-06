/**
 * Normalized outcomes for a Stage 6B send attempt (Section L). An adapter's
 * own implementation-specific errors never escape past `SendApprovedDraftService`
 * — every one of them is mapped to exactly one of these, mirroring
 * `XReadAdapter`'s existing error-normalization discipline.
 */
export const OUTREACH_SEND_OUTCOMES = [
  'SENT',
  'DRY_RUN',
  'ALREADY_SENT',
  'BLOCKED',
  'LIMIT_REACHED',
  'NOT_APPROVED',
  'TARGET_INVALID',
  'MESSAGE_INVALID',
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'NETWORK_ERROR',
  'UNEXPECTED_ERROR',
] as const;
export type OutreachSendOutcome = (typeof OUTREACH_SEND_OUTCOMES)[number];

export interface SendApprovedDraftInput {
  draftId: string;
  /** The caller must explicitly state which prospect this send targets — cross-checked against the draft's own `prospectId` (Section C: never send based on a stale/assumed association). */
  prospectId: string;
  /** Default `false`. See Section I — performs every check with zero network write when `true`. */
  dryRun?: boolean;
}

export interface SendApprovedDraftResult {
  outcome: OutreachSendOutcome;
  reason: string;
  outreachMessageId?: string;
  xMessageId?: string;
  /** Populated only for `DRY_RUN` — safe to log/display (no credentials). */
  wouldSendTo?: { xUserId: string; xUsername: string };
  /** Populated only for `DRY_RUN` — the exact, unmodified approved draft text. */
  wouldSendText?: string;
}
