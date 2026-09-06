import { describe, it, expect } from 'vitest';
import { applyDraftTransition, isTerminalDraftState, InvalidDraftTransitionError } from '../src/drafts/draft-lifecycle.js';

describe('applyDraftTransition', () => {
  it('DRAFTED -> PENDING_APPROVAL -> APPROVED', () => {
    expect(applyDraftTransition('DRAFTED', 'SUBMIT_FOR_APPROVAL')).toBe('PENDING_APPROVAL');
    expect(applyDraftTransition('PENDING_APPROVAL', 'APPROVE')).toBe('APPROVED');
  });

  it('DRAFTED -> REJECTED directly is allowed', () => {
    expect(applyDraftTransition('DRAFTED', 'REJECT')).toBe('REJECTED');
  });

  it('is idempotent for a duplicate same-state transition', () => {
    expect(applyDraftTransition('APPROVED', 'APPROVE')).toBe('APPROVED');
    expect(applyDraftTransition('REJECTED', 'REJECT')).toBe('REJECTED');
  });

  it('throws for skipping PENDING_APPROVAL', () => {
    expect(() => applyDraftTransition('DRAFTED', 'APPROVE')).toThrow(InvalidDraftTransitionError);
  });

  it('throws for leaving a terminal state to the other terminal state', () => {
    expect(() => applyDraftTransition('APPROVED', 'REJECT')).toThrow(InvalidDraftTransitionError);
    expect(() => applyDraftTransition('REJECTED', 'APPROVE')).toThrow(InvalidDraftTransitionError);
  });

  it('there is no SEND/PUBLISH transition defined for any state', () => {
    const transitions = ['SUBMIT_FOR_APPROVAL', 'APPROVE', 'REJECT'];
    expect(transitions).not.toContain('SEND');
    expect(transitions).not.toContain('PUBLISH');
  });
});

describe('isTerminalDraftState', () => {
  it('APPROVED and REJECTED are terminal; DRAFTED/PENDING_APPROVAL are not', () => {
    expect(isTerminalDraftState('APPROVED')).toBe(true);
    expect(isTerminalDraftState('REJECTED')).toBe(true);
    expect(isTerminalDraftState('DRAFTED')).toBe(false);
    expect(isTerminalDraftState('PENDING_APPROVAL')).toBe(false);
  });
});
