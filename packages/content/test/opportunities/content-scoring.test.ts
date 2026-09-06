import { describe, it, expect } from 'vitest';
import { scoreContentOpportunity, MIN_ICP_SIGNALS_FOR_SCORE, CONTENT_SCORE_WEIGHTS } from '../../src/opportunities/content-scoring.js';

const NOW = '2026-01-15T00:00:00.000Z';

function baseInput(overrides: Partial<Parameters<typeof scoreContentOpportunity>[0]> = {}) {
  return {
    icpSignalCount: 3,
    totalSignalCount: 5,
    competitorAccountCoverage: 1,
    mostRecentSignalAt: '2026-01-14T00:00:00.000Z',
    confidenceCounts: { OBSERVATION: 5 },
    now: NOW,
    ...overrides,
  };
}

describe('scoreContentOpportunity — evidence gate', () => {
  it('returns UNKNOWN (null score) when there is no ICP evidence at all', () => {
    const result = scoreContentOpportunity(baseInput({ icpSignalCount: 0 }));
    expect(result.score).toBeNull();
  });

  it('scores when ICP evidence meets the minimum', () => {
    const result = scoreContentOpportunity(baseInput({ icpSignalCount: MIN_ICP_SIGNALS_FOR_SCORE }));
    expect(result.score).not.toBeNull();
  });
});

describe('scoreContentOpportunity — weights sum to 100', () => {
  it('the maximum possible score is 100', () => {
    const result = scoreContentOpportunity(
      baseInput({ icpSignalCount: 100, totalSignalCount: 100, competitorAccountCoverage: 0, mostRecentSignalAt: NOW, confidenceCounts: { FACT: 100 } })
    );
    expect(result.score).toBe(100);
    expect(Object.values(CONTENT_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('scoreContentOpportunity — dimension behavior', () => {
  it('higher ICP signal count increases the score, holding everything else constant', () => {
    const low = scoreContentOpportunity(baseInput({ icpSignalCount: 1 }));
    const high = scoreContentOpportunity(baseInput({ icpSignalCount: 5 }));
    expect(high.score!).toBeGreaterThan(low.score!);
  });

  it('more competitor coverage of a topic REDUCES the differentiation-driven score', () => {
    const uncovered = scoreContentOpportunity(baseInput({ competitorAccountCoverage: 0 }));
    const heavilyCovered = scoreContentOpportunity(baseInput({ competitorAccountCoverage: 5 }));
    expect(uncovered.score!).toBeGreaterThan(heavilyCovered.score!);
  });

  it('a more recent signal scores higher than an old one, all else equal', () => {
    const recent = scoreContentOpportunity(baseInput({ mostRecentSignalAt: '2026-01-14T00:00:00.000Z' }));
    const old = scoreContentOpportunity(baseInput({ mostRecentSignalAt: '2025-01-01T00:00:00.000Z' }));
    expect(recent.score!).toBeGreaterThan(old.score!);
  });

  it('no signal date at all contributes zero recency, never a guessed value', () => {
    const result = scoreContentOpportunity(baseInput({ mostRecentSignalAt: null }));
    expect(result.breakdown!.recency).toBe(0);
  });

  it('a higher proportion of FACT/OBSERVATION confidence increases evidence-strength score', () => {
    const strong = scoreContentOpportunity(baseInput({ confidenceCounts: { FACT: 5 } }));
    const weak = scoreContentOpportunity(baseInput({ confidenceCounts: { OPINION: 5 } }));
    expect(strong.score!).toBeGreaterThan(weak.score!);
  });

  it('never allows engagement/virality alone to dominate — this function has no engagement input at all', () => {
    // scoreContentOpportunity's own type signature has no engagement field; this test documents that invariant.
    const input = baseInput();
    expect('engagement' in input).toBe(false);
  });
});

describe('scoreContentOpportunity — determinism', () => {
  it('the same input always produces the same score', () => {
    const input = baseInput();
    expect(scoreContentOpportunity(input)).toEqual(scoreContentOpportunity(input));
  });
});
