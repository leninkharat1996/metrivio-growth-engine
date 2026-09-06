import { describe, it, expect } from 'vitest';
import { evaluateFollowUpEligibility, type FollowUpEligibilityInput } from '../../src/follow-up/follow-up-eligibility.js';

function baseInput(overrides: Partial<FollowUpEligibilityInput> = {}): FollowUpEligibilityInput {
  return {
    replyState: 'NO_REPLY',
    killSwitchActive: false,
    nextStepAlreadySent: false,
    timing: { lastSentAt: '2026-01-01T00:00:00.000Z', nextStepDayOffset: 3, now: '2026-01-05T00:00:00.000Z' },
    ...overrides,
  };
}

describe('evaluateFollowUpEligibility — basic outcomes', () => {
  it('is ELIGIBLE when due and no reply', () => {
    expect(evaluateFollowUpEligibility(baseInput()).status).toBe('ELIGIBLE');
  });

  it('is NOT_DUE when the day offset has not elapsed', () => {
    const result = evaluateFollowUpEligibility(baseInput({ timing: { lastSentAt: '2026-01-01T00:00:00.000Z', nextStepDayOffset: 3, now: '2026-01-02T00:00:00.000Z' } }));
    expect(result.status).toBe('NOT_DUE');
  });

  it('is ELIGIBLE exactly at the timing boundary', () => {
    const result = evaluateFollowUpEligibility(baseInput({ timing: { lastSentAt: '2026-01-01T00:00:00.000Z', nextStepDayOffset: 3, now: '2026-01-04T00:00:00.000Z' } }));
    expect(result.status).toBe('ELIGIBLE');
  });

  it('is NOT_DUE one millisecond before the boundary', () => {
    const result = evaluateFollowUpEligibility(baseInput({ timing: { lastSentAt: '2026-01-01T00:00:00.000Z', nextStepDayOffset: 3, now: '2026-01-03T23:59:59.999Z' } }));
    expect(result.status).toBe('NOT_DUE');
  });
});

describe('evaluateFollowUpEligibility — critical invariant: reply/opt-out always block, regardless of timing', () => {
  it('REPLIED blocks even when timing would otherwise be ELIGIBLE', () => {
    expect(evaluateFollowUpEligibility(baseInput({ replyState: 'REPLIED' })).status).toBe('REPLIED');
  });

  it('REPLIED blocks even before a follow-up would be due', () => {
    const result = evaluateFollowUpEligibility(
      baseInput({ replyState: 'REPLIED', timing: { lastSentAt: '2026-01-01T00:00:00.000Z', nextStepDayOffset: 30, now: '2026-01-02T00:00:00.000Z' } })
    );
    expect(result.status).toBe('REPLIED');
  });

  it('REPLIED blocks exactly at the follow-up-due boundary', () => {
    const result = evaluateFollowUpEligibility(
      baseInput({ replyState: 'REPLIED', timing: { lastSentAt: '2026-01-01T00:00:00.000Z', nextStepDayOffset: 3, now: '2026-01-04T00:00:00.000Z' } })
    );
    expect(result.status).toBe('REPLIED');
  });

  it('REPLIED blocks even long after a previous follow-up would have been due', () => {
    const result = evaluateFollowUpEligibility(
      baseInput({ replyState: 'REPLIED', timing: { lastSentAt: '2026-01-01T00:00:00.000Z', nextStepDayOffset: 1, now: '2026-06-01T00:00:00.000Z' } })
    );
    expect(result.status).toBe('REPLIED');
  });

  it('multiple replies still resolve to the same REPLIED-blocks-everything outcome (replyState is already a single derived value)', () => {
    // Multiplicity is handled upstream by deriveReplyState (any 1+ prospect
    // messages -> REPLIED) — this evaluator only ever sees the single
    // resulting state, and blocks identically regardless of how many
    // replies produced it.
    expect(evaluateFollowUpEligibility(baseInput({ replyState: 'REPLIED' })).status).toBe('REPLIED');
  });

  it('OPTED_OUT blocks even when timing would otherwise be ELIGIBLE', () => {
    expect(evaluateFollowUpEligibility(baseInput({ replyState: 'OPTED_OUT' })).status).toBe('OPTED_OUT');
  });

  it('OPTED_OUT takes priority over an already-sent-next-step check', () => {
    expect(evaluateFollowUpEligibility(baseInput({ replyState: 'OPTED_OUT', nextStepAlreadySent: true })).status).toBe('OPTED_OUT');
  });
});

describe('evaluateFollowUpEligibility — other blocking states', () => {
  it('STOPPED blocks regardless of timing', () => {
    expect(evaluateFollowUpEligibility(baseInput({ replyState: 'STOPPED' })).status).toBe('STOPPED');
  });

  it('UNKNOWN reply state blocks — never treated as eligible', () => {
    expect(evaluateFollowUpEligibility(baseInput({ replyState: 'UNKNOWN' })).status).toBe('UNKNOWN');
  });

  it('BLOCKED when the kill switch is active, overriding everything else', () => {
    expect(evaluateFollowUpEligibility(baseInput({ killSwitchActive: true, replyState: 'NO_REPLY' })).status).toBe('BLOCKED');
    expect(evaluateFollowUpEligibility(baseInput({ killSwitchActive: true, replyState: 'REPLIED' })).status).toBe('BLOCKED');
  });

  it('ALREADY_SENT when the next step has already been recorded as sent', () => {
    expect(evaluateFollowUpEligibility(baseInput({ nextStepAlreadySent: true })).status).toBe('ALREADY_SENT');
  });

  it('UNKNOWN when no timing information is available at all (no prior send / no next-step definition)', () => {
    expect(evaluateFollowUpEligibility(baseInput({ timing: null })).status).toBe('UNKNOWN');
  });
});

describe('evaluateFollowUpEligibility — determinism', () => {
  it('the same input always produces the same result', () => {
    const input = baseInput();
    expect(evaluateFollowUpEligibility(input)).toEqual(evaluateFollowUpEligibility(input));
  });
});

describe('evaluateFollowUpEligibility — multiple sequence steps (via repeated evaluation)', () => {
  it('step 2 due-check behaves the same as step 1s, given equivalent timing inputs', () => {
    const step1 = evaluateFollowUpEligibility(baseInput({ timing: { lastSentAt: '2026-01-01T00:00:00.000Z', nextStepDayOffset: 3, now: '2026-01-05T00:00:00.000Z' } }));
    const step2 = evaluateFollowUpEligibility(baseInput({ timing: { lastSentAt: '2026-01-10T00:00:00.000Z', nextStepDayOffset: 3, now: '2026-01-14T00:00:00.000Z' } }));
    expect(step1.status).toBe('ELIGIBLE');
    expect(step2.status).toBe('ELIGIBLE');
  });
});
