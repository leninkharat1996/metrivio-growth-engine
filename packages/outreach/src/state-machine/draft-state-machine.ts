/**
 * Message-draft state machine (Stage 6A).
 *
 * The Stage 6A prompt lists a much larger set of *potential* states
 * (DISCOVERED/ENRICHED/SCORED/OUTREACH_ELIGIBLE/DRAFTED/PENDING_APPROVAL/
 * APPROVED/SENT/AWAITING_REPLY/REPLIED/FOLLOWUP_DUE/STOPPED/OPTED_OUT/
 * FAILED), with the explicit instruction to implement only what the
 * current architecture actually justifies. Every one of those states
 * outside this file already has a home elsewhere and does not need a new
 * state machine:
 *   - DISCOVERED / ENRICHED / SCORED are already observable facts (a
 *     `prospects` row existing, `last_enriched_at` being set, an
 *     `icp_scores` row existing) — not something a new machine should
 *     re-track.
 *   - OUTREACH_ELIGIBLE is `OutreachEligibilityStatus.ELIGIBLE`
 *     (`../eligibility/eligibility.ts`) — a live, re-computed read, not a
 *     stored transition.
 *   - STOPPED / OPTED_OUT already exist as `prospects.outreach_status`
 *     values and `conversations.classification` values.
 *   - SENT / AWAITING_REPLY / REPLIED / FOLLOWUP_DUE / FAILED all require
 *     an actual send to have happened, which this stage explicitly does
 *     not implement (see Section H of this stage's instructions).
 *
 * What genuinely is new in Stage 6A is one object — a `MessageDraft` — and
 * its own lifecycle, which is exactly the 4-state machine below.
 */

export const MESSAGE_DRAFT_STATES = ['DRAFTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
export type MessageDraftState = (typeof MESSAGE_DRAFT_STATES)[number];

export const MESSAGE_DRAFT_TRANSITIONS = ['SUBMIT_FOR_APPROVAL', 'APPROVE', 'REJECT'] as const;
export type MessageDraftTransition = (typeof MESSAGE_DRAFT_TRANSITIONS)[number];

export class InvalidDraftTransitionError extends Error {
  constructor(from: MessageDraftState, transition: MessageDraftTransition) {
    super(`Cannot apply transition "${transition}" from state "${from}" — this is not a valid message-draft transition (Stage 6A never allows APPROVED/REJECTED to leave their terminal state, and never allows skipping PENDING_APPROVAL to reach APPROVED directly).`);
    this.name = 'InvalidDraftTransitionError';
  }
}

/**
 * The fixed transition table. `APPROVED` and `REJECTED` are terminal — no
 * outgoing transitions exist for either, which is what makes "no send
 * exists" structurally true rather than merely a convention: there is no
 * `SEND` transition defined anywhere in this table for any state.
 */
const TRANSITIONS: Record<MessageDraftState, Partial<Record<MessageDraftTransition, MessageDraftState>>> = {
  DRAFTED: { SUBMIT_FOR_APPROVAL: 'PENDING_APPROVAL', REJECT: 'REJECTED' },
  PENDING_APPROVAL: { APPROVE: 'APPROVED', REJECT: 'REJECTED' },
  APPROVED: {},
  REJECTED: {},
};

/**
 * Deterministic, pure transition function (instruction L). Idempotent for
 * a duplicate transition that would produce the *same* state the draft is
 * already in (e.g. approving an already-APPROVED draft) — returns the
 * current state unchanged rather than throwing, per instruction M's
 * idempotency requirement. Any other invalid transition (including moving
 * out of a terminal state, or skipping PENDING_APPROVAL) throws
 * `InvalidDraftTransitionError`.
 */
export function applyDraftTransition(current: MessageDraftState, transition: MessageDraftTransition): MessageDraftState {
  const next = TRANSITIONS[current][transition];
  if (next) return next;

  // Idempotent no-op: e.g. APPROVE while already APPROVED, REJECT while
  // already REJECTED. Only exact same-transition-target duplicates are
  // treated this way — a REJECT while APPROVED (a real cross-terminal
  // attempt) still throws below.
  if (current === 'APPROVED' && transition === 'APPROVE') return current;
  if (current === 'REJECTED' && transition === 'REJECT') return current;

  throw new InvalidDraftTransitionError(current, transition);
}

export function isTerminalDraftState(state: MessageDraftState): boolean {
  return state === 'APPROVED' || state === 'REJECTED';
}
