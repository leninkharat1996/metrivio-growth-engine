/**
 * Follow-up / reply-detection contracts (Stage 6A, Sections I/J) — TYPES
 * ONLY. No implementation, no scheduling logic, no read/write adapter call.
 * These exist so a future stage has an agreed-upon shape to implement
 * against, per instruction: "identify the minimum state needed... Define
 * the contract/state boundary needed for a future read-only reply
 * detector."
 *
 * Schema-gap finding (Section I): NONE IDENTIFIED. The minimum state a
 * follow-up/reply system needs is already fully representable by the
 * existing schema, with zero new columns or tables:
 *   - "sent timestamp" -> `outreach_messages.sent_at` (already exists).
 *   - "follow-up eligibility" -> derivable from `sequences.steps[].
 *     day_offset` (the configured wait per step) combined with the prior
 *     step's `outreach_messages.sent_at`, plus the existing
 *     `(prospect_id, sequence_id, sequence_step_order)` unique constraint
 *     that already prevents a duplicate send of the same step.
 *   - "reply detected" -> `conversations.last_message_direction = 'inbound'`
 *     and/or a new `conversation_messages` row with `direction = 'inbound'`
 *     (both already exist).
 *   - "stopped" / "opted out" -> `prospects.outreach_status` (already has
 *     `stopped_*` values) and `conversations.classification` (already has
 *     `OPT_OUT`).
 * Because every piece already exists, this file defines *behavioral*
 * contracts only (what a future service's inputs/outputs should look
 * like) — it does not propose any migration, per Section N ("first
 * determine whether the existing tables can represent this" — they do).
 */

export interface FollowUpEligibilityInput {
  prospectId: string;
  sequenceId: string;
  /** The step just sent (or about to be evaluated for its follow-up). */
  lastSentStepOrder: number;
  lastSentAt: string;
  /** From `sequences.steps[stepOrder].day_offset` for the *next* step. */
  nextStepDayOffset: number;
  /** True the moment a reply is detected — a future implementation must treat this as an immediate, unconditional stop (Section J: "must be able to stop follow-ups immediately when a reply is detected"), overriding any day-offset timing. */
  replyDetected: boolean;
  prospectStopped: boolean;
}

export type FollowUpEligibilityStatus = 'DUE' | 'NOT_YET_DUE' | 'STOPPED_REPLY_DETECTED' | 'STOPPED_PROSPECT_STATUS' | 'NO_FURTHER_STEPS';

export interface FollowUpEligibilityResult {
  status: FollowUpEligibilityStatus;
  reason: string;
}

/**
 * Read-only reply-detection contract for a future adapter — mirrors
 * `XReadAdapter`'s existing shape (a narrow interface, generic error
 * classes, kill-switch-gated implementation) rather than inventing a new
 * pattern. Deliberately unimplemented in Stage 6A: no class implements
 * this interface anywhere in this package.
 */
export interface ReplyDetectionResult {
  prospectId: string;
  conversationId: string;
  /** The specific inbound message that triggered detection, for provenance — mirrors `conversation_messages.x_message_id`. */
  xMessageId: string | null;
  detectedAt: string;
}

export interface ReplyDetector {
  /** Checks for any new inbound messages since a given timestamp, for a specific prospect's conversation. Read-only — must never send anything, mirroring `XReadAdapter`'s read-only boundary exactly. */
  checkForReplies(prospectId: string, sinceTimestamp: string): Promise<ReplyDetectionResult[]>;
}
