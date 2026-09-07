import { describe, it, expect } from 'vitest';
import { classifyBusinessIntent } from '../../src/analytics/business-intent-classifier.js';

describe('classifyBusinessIntent', () => {
  it('returns UNKNOWN for empty/no text (e.g. a bare like)', () => {
    expect(classifyBusinessIntent('')).toBe('UNKNOWN');
    expect(classifyBusinessIntent(null)).toBe('UNKNOWN');
    expect(classifyBusinessIntent(undefined)).toBe('UNKNOWN');
  });

  it('classifies a direct question about Metrivio as GENUINE_INTENT', () => {
    expect(classifyBusinessIntent('How does Metrivio actually work?')).toBe('GENUINE_INTENT');
  });

  it('classifies a methodology/diagnostic question as GENUINE_INTENT', () => {
    expect(classifyBusinessIntent('Curious about your diagnostic methodology')).toBe('GENUINE_INTENT');
  });

  it('classifies a request to talk/DM as GENUINE_INTENT', () => {
    expect(classifyBusinessIntent('Can we hop on a call about this?')).toBe('GENUINE_INTENT');
  });

  it('classifies "for my store" as GENUINE_INTENT', () => {
    expect(classifyBusinessIntent('How would this work for my store?')).toBe('GENUINE_INTENT');
  });

  it('never classifies a generic positive reaction as business intent', () => {
    expect(classifyBusinessIntent('love this 🔥')).toBe('GENERIC_ENGAGEMENT');
    expect(classifyBusinessIntent('so true')).toBe('GENERIC_ENGAGEMENT');
    expect(classifyBusinessIntent('great point')).toBe('GENERIC_ENGAGEMENT');
  });

  it('classifies unrelated substantive text as GENERIC_ENGAGEMENT, not GENUINE_INTENT', () => {
    expect(classifyBusinessIntent('I read a great book about this last year')).toBe('GENERIC_ENGAGEMENT');
  });
});
