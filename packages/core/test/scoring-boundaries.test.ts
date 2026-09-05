import { describe, it, expect } from 'vitest';
import {
  ICP_FACTOR_WEIGHTS,
  ICP_EVIDENCE_TIER_MULTIPLIERS,
  ICP_SCORE_BANDS,
  tierForScore,
} from '../src/scoring/constants.js';

describe('ICP scoring boundaries (constants transcribed from docs/02-metrivio-icp.md §22)', () => {
  it('factor weights match the ICP document exactly', () => {
    expect(ICP_FACTOR_WEIGHTS).toEqual({
      revenueFit: 25,
      paidAcquisition: 25,
      maturity: 15,
      decisionMaker: 15,
      trigger: 15,
      dtcFit: 5,
    });
  });

  it('factor weights sum to exactly 100', () => {
    const total = Object.values(ICP_FACTOR_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBe(100);
  });

  it('evidence tier multipliers match the ICP document exactly', () => {
    expect(ICP_EVIDENCE_TIER_MULTIPLIERS).toEqual({
      CONFIRMED: 1.0,
      STRONG_EVIDENCE: 0.8,
      LIKELY: 0.4,
      UNKNOWN: 0.0,
    });
  });

  it('UNKNOWN tier always yields a zero multiplier (no partial credit)', () => {
    expect(ICP_EVIDENCE_TIER_MULTIPLIERS.UNKNOWN).toBe(0);
  });

  it('score bands match the ICP document exactly (90/75/60 boundaries)', () => {
    expect(ICP_SCORE_BANDS.A.min).toBe(90);
    expect(ICP_SCORE_BANDS.B.min).toBe(75);
    expect(ICP_SCORE_BANDS.B.max).toBe(89);
    expect(ICP_SCORE_BANDS.C.min).toBe(60);
    expect(ICP_SCORE_BANDS.C.max).toBe(74);
    expect(ICP_SCORE_BANDS.Reject.max).toBe(59);
  });

  describe('tierForScore boundary behavior (worked examples from ICP §22.F)', () => {
    it('90 is the A boundary (worked example: score 90 -> A)', () => {
      expect(tierForScore(90)).toBe('A');
      expect(tierForScore(89)).toBe('B');
    });

    it('95 is A (worked example: CONFIRMED path -> 95 -> A)', () => {
      expect(tierForScore(95)).toBe('A');
    });

    it('83 is B (worked example: score 83 -> B)', () => {
      expect(tierForScore(83)).toBe('B');
    });

    it('75 is the B boundary', () => {
      expect(tierForScore(75)).toBe('B');
      expect(tierForScore(74)).toBe('C');
    });

    it('63 is C (worked example: score 63 -> C)', () => {
      expect(tierForScore(63)).toBe('C');
    });

    it('60 is the C boundary', () => {
      expect(tierForScore(60)).toBe('C');
      expect(tierForScore(59)).toBe('Reject');
    });

    it('24 is Reject (worked example: score 24 -> Reject)', () => {
      expect(tierForScore(24)).toBe('Reject');
    });

    it('100 is A (upper bound)', () => {
      expect(tierForScore(100)).toBe('A');
    });

    it('0 is Reject (lower bound)', () => {
      expect(tierForScore(0)).toBe('Reject');
    });
  });

  // NOTE: this suite intentionally does not test the full deterministic scoring
  // algorithm (exclusion checks, checklist-factor point tables, the ICP §22.F
  // worked examples end-to-end) — that is Stage 3 scope per BUILD_PLAN.md. This
  // suite covers only the fixed constants and score-band boundaries defined so far.
});
