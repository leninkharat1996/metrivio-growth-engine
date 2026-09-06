import { describe, it, expect } from 'vitest';
import { classifyPainIntent } from '../../src/discovery/pain-intent-classifier.js';

describe('classifyPainIntent', () => {
  it('matches CAC', () => {
    expect(classifyPainIntent('Our CAC is out of control this quarter.').topic).toBe('CAC');
  });

  it('matches ROAS', () => {
    expect(classifyPainIntent('ROAS has been dropping across every campaign.').topic).toBe('ROAS');
  });

  it('matches MER', () => {
    expect(classifyPainIntent('Trying to improve our MER before Q4.').topic).toBe('MER');
  });

  it('matches attribution', () => {
    expect(classifyPainIntent('Attribution across channels is a mess right now.').topic).toBe('attribution');
  });

  it('matches budget_allocation', () => {
    expect(classifyPainIntent('Struggling with budget allocation across Meta and Google.').topic).toBe('budget_allocation');
  });

  it('matches channel_performance', () => {
    expect(classifyPainIntent('Channel performance has been inconsistent lately.').topic).toBe('channel_performance');
  });

  it('matches profitability', () => {
    expect(classifyPainIntent('Profitability is the whole team\'s focus this year.').topic).toBe('profitability');
  });

  it('a tweet with none of the fixed topics does not match', () => {
    const result = classifyPainIntent('Just launched a new product, excited!');
    expect(result.matched).toBe(false);
    expect(result.topic).toBeNull();
  });

  it('a match is only ever one of the fixed pain_signals.topic enum values (no invented categories)', () => {
    const result = classifyPainIntent('Our CAC and ROAS are both up this month.');
    // First match wins deterministically (CAC checked before ROAS) — the point is it's a valid enum value.
    expect(['CAC', 'ROAS', 'MER', 'attribution', 'budget_allocation', 'channel_performance', 'profitability']).toContain(
      result.topic
    );
  });
});
