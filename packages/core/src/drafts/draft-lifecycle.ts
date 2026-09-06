/**
 * Generic draft-lifecycle state machine — extracted to `packages/core` in
 * Stage 7 so both `packages/outreach` (Stage 6A's `MessageDraft`) and
 * `packages/content` (Stage 7's content drafts) share exactly one
 * implementation of the same DRAFTED -> PENDING_APPROVAL -> APPROVED/
 * REJECTED lifecycle, rather than each package maintaining its own copy of
 * an identical, fully generic 4-state machine. This module has no
 * knowledge of messages, prospects, or content — it is pure state-shape
 * logic, safe to share.
 *
 * `packages/outreach/src/state-machine/draft-state-machine.ts` re-exports
 * this module under its original Stage 6A names (`MessageDraftState`,
 * `MESSAGE_DRAFT_STATES`, etc.) so every existing import path and test in
 * that package continues to work unchanged.
 */

export const DRAFT_LIFECYCLE_STATES = ['DRAFTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
export type DraftLifecycleState = (typeof DRAFT_LIFECYCLE_STATES)[number];

export const DRAFT_LIFECYCLE_TRANSITIONS = ['SUBMIT_FOR_APPROVAL', 'APPROVE', 'REJECT'] as const;
export type DraftLifecycleTransition = (typeof DRAFT_LIFECYCLE_TRANSITIONS)[number];

export class InvalidDraftTransitionError extends Error {
  constructor(from: DraftLifecycleState, transition: DraftLifecycleTransition) {
    super(`Cannot apply transition "${transition}" from state "${from}" — this is not a valid draft transition (APPROVED/REJECTED are terminal, and PENDING_APPROVAL can never be skipped to reach APPROVED directly).`);
    this.name = 'InvalidDraftTransitionError';
  }
}

/**
 * The fixed transition table. `APPROVED` and `REJECTED` are terminal — no
 * outgoing transitions exist for either, which is what makes "no send/
 * publish exists" structurally true rather than merely a convention: there
 * is no `SEND`/`PUBLISH` transition defined anywhere in this table for any
 * state.
 */
const TRANSITIONS: Record<DraftLifecycleState, Partial<Record<DraftLifecycleTransition, DraftLifecycleState>>> = {
  DRAFTED: { SUBMIT_FOR_APPROVAL: 'PENDING_APPROVAL', REJECT: 'REJECTED' },
  PENDING_APPROVAL: { APPROVE: 'APPROVED', REJECT: 'REJECTED' },
  APPROVED: {},
  REJECTED: {},
};

/**
 * Deterministic, pure transition function. Idempotent for a duplicate
 * transition that would produce the SAME state the draft is already in
 * (e.g. approving an already-APPROVED draft) — returns the current state
 * unchanged rather than throwing. Any other invalid transition (including
 * moving out of a terminal state, or skipping PENDING_APPROVAL) throws
 * `InvalidDraftTransitionError`.
 */
export function applyDraftTransition(current: DraftLifecycleState, transition: DraftLifecycleTransition): DraftLifecycleState {
  const next = TRANSITIONS[current][transition];
  if (next) return next;

  if (current === 'APPROVED' && transition === 'APPROVE') return current;
  if (current === 'REJECTED' && transition === 'REJECT') return current;

  throw new InvalidDraftTransitionError(current, transition);
}

export function isTerminalDraftState(state: DraftLifecycleState): boolean {
  return state === 'APPROVED' || state === 'REJECTED';
}
