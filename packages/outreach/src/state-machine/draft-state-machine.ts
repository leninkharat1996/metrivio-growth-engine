/**
 * Message-draft state machine (Stage 6A).
 *
 * As of Stage 7, the actual 4-state machine implementation moved to
 * `packages/core/src/drafts/draft-lifecycle.ts` — it was fully generic
 * (no message/prospect-specific logic at all), so Stage 7's content-draft
 * lifecycle now shares the exact same implementation rather than
 * duplicating it. This file re-exports that shared module under its
 * original Stage 6A names so every existing import path in this package
 * (and every existing test) continues to work completely unchanged.
 */
import {
  DRAFT_LIFECYCLE_STATES,
  DRAFT_LIFECYCLE_TRANSITIONS,
  applyDraftTransition as applyDraftTransitionCore,
  isTerminalDraftState as isTerminalDraftStateCore,
  InvalidDraftTransitionError as InvalidDraftTransitionErrorCore,
  type DraftLifecycleState,
  type DraftLifecycleTransition,
} from '@metrivio/core';

export const MESSAGE_DRAFT_STATES = DRAFT_LIFECYCLE_STATES;
export type MessageDraftState = DraftLifecycleState;

export const MESSAGE_DRAFT_TRANSITIONS = DRAFT_LIFECYCLE_TRANSITIONS;
export type MessageDraftTransition = DraftLifecycleTransition;

export const InvalidDraftTransitionError = InvalidDraftTransitionErrorCore;
export const applyDraftTransition = applyDraftTransitionCore;
export const isTerminalDraftState = isTerminalDraftStateCore;
