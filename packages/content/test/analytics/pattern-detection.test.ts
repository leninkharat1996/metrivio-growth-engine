import { describe, it, expect } from 'vitest';
import { derivePatternStrength, derivePerformanceDirection } from '../../src/analytics/pattern-detection.js';

describe('derivePatternStrength — Section T statistical honesty', () => {
  it('returns INSUFFICIENT_DATA for 1 observation', () => {
    expect(derivePatternStrength(1)).toBe('INSUFFICIENT_DATA');
  });
  it('returns INSUFFICIENT_DATA for 2 observations', () => {
    expect(derivePatternStrength(2)).toBe('INSUFFICIENT_DATA');
  });
  it('returns POTENTIAL_PATTERN at the 3-observation threshold', () => {
    expect(derivePatternStrength(3)).toBe('POTENTIAL_PATTERN');
    expect(derivePatternStrength(4)).toBe('POTENTIAL_PATTERN');
  });
  it('returns OBSERVED_PATTERN at the 5-observation threshold', () => {
    expect(derivePatternStrength(5)).toBe('OBSERVED_PATTERN');
    expect(derivePatternStrength(10)).toBe('OBSERVED_PATTERN');
  });
  it('returns INSUFFICIENT_DATA for zero observations', () => {
    expect(derivePatternStrength(0)).toBe('INSUFFICIENT_DATA');
  });
});

describe('derivePerformanceDirection — Section I/J', () => {
  it('returns INSUFFICIENT_DATA below the minimum sample size regardless of the score delta', () => {
    expect(derivePerformanceDirection(100, 10, 2)).toBe('INSUFFICIENT_DATA');
  });
  it('returns INSUFFICIENT_DATA when either average is null', () => {
    expect(derivePerformanceDirection(null, 10, 5)).toBe('INSUFFICIENT_DATA');
    expect(derivePerformanceDirection(10, null, 5)).toBe('INSUFFICIENT_DATA');
  });
  it('returns INSUFFICIENT_DATA when the baseline is zero (division-by-zero guard)', () => {
    expect(derivePerformanceDirection(10, 0, 5)).toBe('INSUFFICIENT_DATA');
  });
  it('returns PROMISING when the group meaningfully beats the baseline, with sufficient sample size', () => {
    expect(derivePerformanceDirection(20, 10, 3)).toBe('PROMISING');
  });
  it('returns UNDERPERFORMING when the group meaningfully trails the baseline, with sufficient sample size', () => {
    expect(derivePerformanceDirection(5, 10, 3)).toBe('UNDERPERFORMING');
  });
  it('returns NEUTRAL when the group is close to the baseline (within the margin)', () => {
    expect(derivePerformanceDirection(10.5, 10, 3)).toBe('NEUTRAL');
  });
});
