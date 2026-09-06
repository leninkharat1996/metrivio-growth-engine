import { describe, it, expect } from 'vitest';
import { deriveReplyState } from '../../src/follow-up/reply-state.js';

function baseInput(overrides: Partial<Parameters<typeof deriveReplyState>[0]> = {}) {
  return { detectionSucceeded: true, hasProspectMessage: false, optOutDetected: false, prospectStopped: false, ...overrides };
}

describe('deriveReplyState', () => {
  it('returns NO_REPLY when detection succeeded and nothing was found', () => {
    expect(deriveReplyState(baseInput()).state).toBe('NO_REPLY');
  });

  it('returns REPLIED when a prospect message exists', () => {
    expect(deriveReplyState(baseInput({ hasProspectMessage: true })).state).toBe('REPLIED');
  });

  it('returns UNKNOWN when detection did not succeed, regardless of other flags', () => {
    expect(deriveReplyState(baseInput({ detectionSucceeded: false })).state).toBe('UNKNOWN');
    expect(deriveReplyState(baseInput({ detectionSucceeded: false, hasProspectMessage: true })).state).toBe('UNKNOWN');
    expect(deriveReplyState(baseInput({ detectionSucceeded: false, optOutDetected: true })).state).toBe('UNKNOWN');
  });

  it('never collapses UNKNOWN into NO_REPLY — a failed detection is not "no reply"', () => {
    const result = deriveReplyState(baseInput({ detectionSucceeded: false }));
    expect(result.state).not.toBe('NO_REPLY');
  });

  it('returns OPTED_OUT when opt-out was detected, taking priority over STOPPED/REPLIED', () => {
    expect(deriveReplyState(baseInput({ optOutDetected: true, prospectStopped: true, hasProspectMessage: true })).state).toBe('OPTED_OUT');
  });

  it('returns STOPPED when the prospect is stopped, taking priority over REPLIED', () => {
    expect(deriveReplyState(baseInput({ prospectStopped: true, hasProspectMessage: true })).state).toBe('STOPPED');
  });

  it('is deterministic', () => {
    const input = baseInput({ hasProspectMessage: true });
    expect(deriveReplyState(input)).toEqual(deriveReplyState(input));
  });
});
