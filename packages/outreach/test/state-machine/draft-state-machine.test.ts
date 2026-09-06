import { describe, it, expect } from 'vitest';
import { applyDraftTransition, isTerminalDraftState, InvalidDraftTransitionError } from '../../src/state-machine/draft-state-machine.js';

describe('applyDraftTransition — valid transitions', () => {
  it('DRAFTED -> PENDING_APPROVAL via SUBMIT_FOR_APPROVAL', () => {
    expect(applyDraftTransition('DRAFTED', 'SUBMIT_FOR_APPROVAL')).toBe('PENDING_APPROVAL');
  });

  it('PENDING_APPROVAL -> APPROVED via APPROVE', () => {
    expect(applyDraftTransition('PENDING_APPROVAL', 'APPROVE')).toBe('APPROVED');
  });

  it('PENDING_APPROVAL -> REJECTED via REJECT', () => {
    expect(applyDraftTransition('PENDING_APPROVAL', 'REJECT')).toBe('REJECTED');
  });

  it('DRAFTED -> REJECTED via REJECT (a draft can be rejected before ever being submitted)', () => {
    expect(applyDraftTransition('DRAFTED', 'REJECT')).toBe('REJECTED');
  });
});

describe('applyDraftTransition — invalid transitions', () => {
  it('rejects DRAFTED -> APPROVED directly (cannot skip PENDING_APPROVAL)', () => {
    expect(() => applyDraftTransition('DRAFTED', 'APPROVE')).toThrow(InvalidDraftTransitionError);
  });

  it('rejects REJECTED -> APPROVED (cannot leave a terminal state)', () => {
    expect(() => applyDraftTransition('REJECTED', 'APPROVE')).toThrow(InvalidDraftTransitionError);
  });

  it('rejects APPROVED -> REJECTED (cannot leave a terminal state)', () => {
    expect(() => applyDraftTransition('APPROVED', 'REJECT')).toThrow(InvalidDraftTransitionError);
  });

  it('rejects PENDING_APPROVAL -> PENDING_APPROVAL via SUBMIT_FOR_APPROVAL again (no self-loop defined for this transition)', () => {
    expect(() => applyDraftTransition('PENDING_APPROVAL', 'SUBMIT_FOR_APPROVAL')).toThrow(InvalidDraftTransitionError);
  });

  it('there is no SEND transition from any state — APPROVED -> SENT does not exist', () => {
    // @ts-expect-error — SEND is intentionally not part of MessageDraftTransition at all.
    expect(() => applyDraftTransition('APPROVED', 'SEND')).toThrow();
  });
});

describe('applyDraftTransition — idempotent duplicate transitions', () => {
  it('APPROVE while already APPROVED is a no-op, not an error', () => {
    expect(applyDraftTransition('APPROVED', 'APPROVE')).toBe('APPROVED');
  });

  it('REJECT while already REJECTED is a no-op, not an error', () => {
    expect(applyDraftTransition('REJECTED', 'REJECT')).toBe('REJECTED');
  });
});

describe('isTerminalDraftState', () => {
  it('APPROVED and REJECTED are terminal', () => {
    expect(isTerminalDraftState('APPROVED')).toBe(true);
    expect(isTerminalDraftState('REJECTED')).toBe(true);
  });

  it('DRAFTED and PENDING_APPROVAL are not terminal', () => {
    expect(isTerminalDraftState('DRAFTED')).toBe(false);
    expect(isTerminalDraftState('PENDING_APPROVAL')).toBe(false);
  });
});

describe('determinism', () => {
  it('the same (state, transition) pair always produces the same result', () => {
    const first = applyDraftTransition('DRAFTED', 'SUBMIT_FOR_APPROVAL');
    const second = applyDraftTransition('DRAFTED', 'SUBMIT_FOR_APPROVAL');
    expect(first).toBe(second);
  });
});
