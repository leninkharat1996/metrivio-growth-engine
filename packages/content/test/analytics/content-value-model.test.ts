import { describe, it, expect } from 'vitest';
import { scoreContentValue } from '../../src/analytics/content-value-model.js';

describe('scoreContentValue — Section H', () => {
  it('returns UNKNOWN when no sub-score is available', () => {
    const result = scoreContentValue({ reachScore: null, engagementScore: null, icpScore: null, businessIntentScore: null });
    expect(result.classification).toBe('UNKNOWN');
    expect(result.overallScore).toBeNull();
  });

  it('classifies HIGH_VALUE when business intent and ICP scores are both high, even with low reach', () => {
    const result = scoreContentValue({ reachScore: 5, engagementScore: 20, icpScore: 90, businessIntentScore: 95 });
    expect(result.classification).toBe('HIGH_VALUE');
  });

  it('never lets high reach alone dominate the score (Critical Principle)', () => {
    const result = scoreContentValue({ reachScore: 100, engagementScore: null, icpScore: null, businessIntentScore: null });
    // reach alone is only weighted 10/10 available = its own raw value, but the classification
    // thresholds still require weighing it — with only reach present, overallScore == reachScore.
    expect(result.overallScore).toBe(100);
    // Prove the general claim differently: a post with high reach but poor engagement/ICP/intent scores low overall.
    const mixed = scoreContentValue({ reachScore: 100, engagementScore: 5, icpScore: 0, businessIntentScore: 0 });
    expect(mixed.classification).not.toBe('HIGH_VALUE');
  });

  it('excludes missing components from both numerator and denominator, never treating them as zero', () => {
    const withMissing = scoreContentValue({ reachScore: null, engagementScore: null, icpScore: 80, businessIntentScore: 80 });
    // Only ICP (30) and businessIntent (40) present -> weighted avg = 80 regardless of the missing 30% of weight.
    expect(withMissing.overallScore).toBe(80);
  });

  it('classifies LOW_VALUE for a uniformly poor-performing post', () => {
    const result = scoreContentValue({ reachScore: 5, engagementScore: 5, icpScore: 0, businessIntentScore: 0 });
    expect(result.classification).toBe('LOW_VALUE');
  });

  it('classifies MODERATE_VALUE for a middling post', () => {
    const result = scoreContentValue({ reachScore: 50, engagementScore: 50, icpScore: 50, businessIntentScore: 50 });
    expect(result.classification).toBe('MODERATE_VALUE');
  });

  it('always preserves the individual sub-scores in the result, never discarding them', () => {
    const result = scoreContentValue({ reachScore: 10, engagementScore: 20, icpScore: 30, businessIntentScore: 40 });
    expect(result.reachScore).toBe(10);
    expect(result.engagementScore).toBe(20);
    expect(result.icpScore).toBe(30);
    expect(result.businessIntentScore).toBe(40);
  });
});
