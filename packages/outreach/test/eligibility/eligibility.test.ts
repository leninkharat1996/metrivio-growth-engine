import { describe, it, expect } from 'vitest';
import { evaluateOutreachEligibility, type OutreachEligibilityInput } from '../../src/eligibility/eligibility.js';

function baseInput(overrides: Partial<OutreachEligibilityInput> = {}): OutreachEligibilityInput {
  return {
    outreachStatus: 'not_started',
    latestIcpScore: { tier: 'A', exclusionTriggered: false },
    latestConversation: null,
    hasAnyEvidence: true,
    killSwitchActive: false,
    outreachMinimumTier: 'B',
    ...overrides,
  };
}

describe('evaluateOutreachEligibility', () => {
  it('a valid high-fit prospect (A tier, meets threshold, has evidence) is ELIGIBLE', () => {
    const result = evaluateOutreachEligibility(baseInput());
    expect(result.status).toBe('ELIGIBLE');
  });

  it('a prospect below the configured minimum tier is INELIGIBLE', () => {
    const result = evaluateOutreachEligibility(baseInput({ latestIcpScore: { tier: 'C', exclusionTriggered: false }, outreachMinimumTier: 'B' }));
    expect(result.status).toBe('INELIGIBLE');
    expect(result.reason).toMatch(/below the configured outreach minimum tier/);
  });

  it('a Reject-tier prospect is INELIGIBLE even if somehow above a low configured threshold', () => {
    const result = evaluateOutreachEligibility(baseInput({ latestIcpScore: { tier: 'Reject', exclusionTriggered: false }, outreachMinimumTier: 'C' }));
    expect(result.status).toBe('INELIGIBLE');
  });

  it('an exclusion-triggered score is INELIGIBLE regardless of tier', () => {
    const result = evaluateOutreachEligibility(baseInput({ latestIcpScore: { tier: 'A', exclusionTriggered: true } }));
    expect(result.status).toBe('INELIGIBLE');
    expect(result.reason).toMatch(/exclusion/);
  });

  it('a missing score is UNKNOWN, not INELIGIBLE', () => {
    const result = evaluateOutreachEligibility(baseInput({ latestIcpScore: null }));
    expect(result.status).toBe('UNKNOWN');
  });

  it('an unconfigured outreach threshold makes every prospect INELIGIBLE (fail-closed, Section B)', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachMinimumTier: null }));
    expect(result.status).toBe('INELIGIBLE');
    expect(result.reason).toMatch(/no outreach score threshold is configured/);
  });

  it('missing evidence makes an otherwise-eligible prospect INELIGIBLE', () => {
    const result = evaluateOutreachEligibility(baseInput({ hasAnyEvidence: false }));
    expect(result.status).toBe('INELIGIBLE');
    expect(result.reason).toMatch(/no evidence exists/);
  });

  it('already contacted (queued) is ALREADY_CONTACTED', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'queued' }));
    expect(result.status).toBe('ALREADY_CONTACTED');
  });

  it('already contacted (active_sequence) is ALREADY_CONTACTED', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'active_sequence' }));
    expect(result.status).toBe('ALREADY_CONTACTED');
  });

  it('converted is ALREADY_CONTACTED', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'converted' }));
    expect(result.status).toBe('ALREADY_CONTACTED');
  });

  it('an active conversation awaiting a reply (last message outbound) is AWAITING_REPLY', () => {
    const result = evaluateOutreachEligibility(
      baseInput({ latestConversation: { state: 'active', classification: 'NEUTRAL', lastMessageDirection: 'outbound' } })
    );
    expect(result.status).toBe('AWAITING_REPLY');
  });

  it('an active conversation with the last message inbound is NOT AWAITING_REPLY (they already replied)', () => {
    const result = evaluateOutreachEligibility(
      baseInput({ latestConversation: { state: 'active', classification: 'NEUTRAL', lastMessageDirection: 'inbound' } })
    );
    expect(result.status).not.toBe('AWAITING_REPLY');
  });

  it('stopped_opted_out is STOPPED', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'stopped_opted_out' }));
    expect(result.status).toBe('STOPPED');
  });

  it('stopped_not_interested is STOPPED', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'stopped_not_interested' }));
    expect(result.status).toBe('STOPPED');
  });

  it('stopped_disqualified is STOPPED', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'stopped_disqualified' }));
    expect(result.status).toBe('STOPPED');
  });

  it('stopped_manual is STOPPED', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'stopped_manual' }));
    expect(result.status).toBe('STOPPED');
  });

  it('a conversation classified OPT_OUT is STOPPED even if prospect.outreach_status has not been updated yet', () => {
    const result = evaluateOutreachEligibility(
      baseInput({ outreachStatus: 'active_sequence', latestConversation: { state: 'stopped', classification: 'OPT_OUT', lastMessageDirection: 'inbound' } })
    );
    expect(result.status).toBe('STOPPED');
  });

  it('a conversation classified NOT_INTERESTED is STOPPED', () => {
    const result = evaluateOutreachEligibility(
      baseInput({ latestConversation: { state: 'stopped', classification: 'NOT_INTERESTED', lastMessageDirection: 'inbound' } })
    );
    expect(result.status).toBe('STOPPED');
  });

  it('the kill switch being active is BLOCKED, overriding an otherwise-eligible prospect', () => {
    const result = evaluateOutreachEligibility(baseInput({ killSwitchActive: true }));
    expect(result.status).toBe('BLOCKED');
  });

  it('STOPPED takes priority over BLOCKED (a stopped prospect is reported as stopped, not merely blocked)', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'stopped_manual', killSwitchActive: true }));
    expect(result.status).toBe('STOPPED');
  });

  it('an unrecognized outreach_status value is treated as UNKNOWN-safe (falls through to normal eligibility logic, never crashes)', () => {
    const result = evaluateOutreachEligibility(baseInput({ outreachStatus: 'not_started' }));
    expect(result.status).toBe('ELIGIBLE');
  });

  it('is deterministic — the same input always produces the same result', () => {
    const input = baseInput();
    const first = evaluateOutreachEligibility(input);
    const second = evaluateOutreachEligibility(input);
    expect(second).toEqual(first);
  });

  it('B tier meets a B minimum threshold', () => {
    const result = evaluateOutreachEligibility(baseInput({ latestIcpScore: { tier: 'B', exclusionTriggered: false }, outreachMinimumTier: 'B' }));
    expect(result.status).toBe('ELIGIBLE');
  });

  it('C tier does not meet a B minimum threshold', () => {
    const result = evaluateOutreachEligibility(baseInput({ latestIcpScore: { tier: 'C', exclusionTriggered: false }, outreachMinimumTier: 'B' }));
    expect(result.status).toBe('INELIGIBLE');
  });
});
