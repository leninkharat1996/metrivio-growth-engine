import type { ReplyState } from './reply-state.js';

/**
 * Pure follow-up eligibility evaluator (Stage 6C, Section F). Never
 * schedules or sends anything — this only answers "would a follow-up be
 * eligible right now," for a caller (a future stage) to act on.
 *
 * Critical invariant (Section H): once `replyState` is `'REPLIED'` or
 * `'OPTED_OUT'`, no timing/dedup input can ever produce `'ELIGIBLE'` —
 * both are checked and returned before any timing math runs at all.
 */
export const FOLLOW_UP_ELIGIBILITY_STATUSES = [
  'ELIGIBLE',
  'NOT_DUE',
  'REPLIED',
  'STOPPED',
  'OPTED_OUT',
  'UNKNOWN',
  'ALREADY_SENT',
  'BLOCKED',
] as const;
export type FollowUpEligibilityStatus = (typeof FOLLOW_UP_ELIGIBILITY_STATUSES)[number];

export interface FollowUpEligibilityResult {
  status: FollowUpEligibilityStatus;
  reason: string;
}

export interface FollowUpTimingInput {
  /** ISO timestamp of the most recent sent message in this sequence. */
  lastSentAt: string;
  /** From `sequences.steps[nextStepOrder].day_offset` — the configured wait, in days, before the next step is due. */
  nextStepDayOffset: number;
  /** Injected explicitly for determinism/testability — never read from the system clock inside this pure function. */
  now: string;
}

export interface FollowUpEligibilityInput {
  replyState: ReplyState;
  killSwitchActive: boolean;
  /**
   * `true` when an `outreach_messages` row already exists (status `queued`
   * or `sent`) for the next sequence step — reuses the exact dedup pattern
   * already established by Stage 6B's `outreach_messages` unique index,
   * read-only here (Stage 6C never writes to `outreach_messages`).
   */
  nextStepAlreadySent: boolean;
  /**
   * `null` when timing cannot be determined at all — no prior sent
   * message in this sequence, or no next-step definition exists in
   * `sequences.steps`. Per Section G: "if no sequence timing is defined,
   * return NOT_DUE/UNKNOWN rather than inventing timing" — this function
   * returns UNKNOWN specifically for the "no definition at all" case, and
   * NOT_DUE only once a real definition's day_offset genuinely hasn't
   * elapsed yet.
   */
  timing: FollowUpTimingInput | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateFollowUpEligibility(input: FollowUpEligibilityInput): FollowUpEligibilityResult {
  if (input.killSwitchActive) {
    return { status: 'BLOCKED', reason: 'the kill switch is active' };
  }

  if (input.replyState === 'OPTED_OUT') {
    return { status: 'OPTED_OUT', reason: 'the prospect has explicitly opted out — no follow-up is ever eligible again' };
  }
  if (input.replyState === 'STOPPED') {
    return { status: 'STOPPED', reason: 'the prospect is in a stopped state' };
  }
  if (input.replyState === 'REPLIED') {
    return { status: 'REPLIED', reason: 'the prospect has replied — no follow-up is eligible regardless of timing (Section H invariant)' };
  }
  if (input.replyState === 'UNKNOWN') {
    return { status: 'UNKNOWN', reason: 'reply state could not be determined — a follow-up cannot safely be considered eligible' };
  }

  if (input.nextStepAlreadySent) {
    return { status: 'ALREADY_SENT', reason: 'a message for the next sequence step has already been recorded as queued or sent' };
  }

  if (!input.timing) {
    return { status: 'UNKNOWN', reason: 'no follow-up timing could be determined (no prior sent message in this sequence, or no next-step definition exists)' };
  }

  const dueAtMs = new Date(input.timing.lastSentAt).getTime() + input.timing.nextStepDayOffset * DAY_MS;
  const nowMs = new Date(input.timing.now).getTime();
  if (!Number.isFinite(dueAtMs) || !Number.isFinite(nowMs)) {
    return { status: 'UNKNOWN', reason: 'timing inputs could not be parsed as valid timestamps' };
  }

  if (nowMs < dueAtMs) {
    return { status: 'NOT_DUE', reason: `follow-up becomes due at ${new Date(dueAtMs).toISOString()}, which is in the future` };
  }
  return { status: 'ELIGIBLE', reason: `follow-up was due at ${new Date(dueAtMs).toISOString()}, which has passed` };
}
