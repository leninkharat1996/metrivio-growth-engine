/**
 * Stage 9, Section T — statistical-honesty thresholds, named once and
 * reused everywhere a "is this a real pattern or a fluke" judgment is
 * made (winner detection, loser detection, growth-technique promotion).
 * Deliberately distinct, slightly stricter numbers than
 * `growth-technique-library.ts`'s own `MIN_OBSERVATIONS_FOR_LIKELY`/
 * `MIN_OBSERVATIONS_FOR_OBSERVED` (2/3) — that module governs whether a
 * technique description is worth recording as a candidate at all, this
 * one governs whether Stage 9's own analysis is willing to call something
 * a genuine repeated PATTERN, which the prompt's own worked example
 * ("1 post: INSUFFICIENT_DATA; 2 posts: INSUFFICIENT_DATA") requires to be
 * a higher bar.
 */
export const PATTERN_STRENGTHS = ['INSUFFICIENT_DATA', 'POTENTIAL_PATTERN', 'OBSERVED_PATTERN'] as const;
export type PatternStrength = (typeof PATTERN_STRENGTHS)[number];

export const MIN_OBSERVATIONS_FOR_POTENTIAL_PATTERN = 3;
export const MIN_OBSERVATIONS_FOR_OBSERVED_PATTERN = 5;

export function derivePatternStrength(observationCount: number): PatternStrength {
  if (observationCount >= MIN_OBSERVATIONS_FOR_OBSERVED_PATTERN) return 'OBSERVED_PATTERN';
  if (observationCount >= MIN_OBSERVATIONS_FOR_POTENTIAL_PATTERN) return 'POTENTIAL_PATTERN';
  return 'INSUFFICIENT_DATA';
}

/**
 * Section I/J — performance-direction classification for one group
 * (a topic/hook/format/CTA bucket) relative to the account-wide baseline.
 * Requires the same minimum sample size as `POTENTIAL_PATTERN` before
 * expressing any direction at all — a single post is never enough to call
 * something PROMISING or UNDERPERFORMING, regardless of how extreme its
 * score is (Section J: "avoid declaring something a failure from one post
 * / tiny sample").
 */
export const PERFORMANCE_DIRECTIONS = ['PROMISING', 'NEUTRAL', 'UNDERPERFORMING', 'INSUFFICIENT_DATA'] as const;
export type PerformanceDirection = (typeof PERFORMANCE_DIRECTIONS)[number];

/** A group's average must beat the baseline by at least this relative margin to be called PROMISING/UNDERPERFORMING — anything closer is NEUTRAL, not noise dressed up as a signal. */
const DIRECTION_RELATIVE_MARGIN = 0.15;

export function derivePerformanceDirection(groupAverage: number | null, baselineAverage: number | null, sampleSize: number): PerformanceDirection {
  if (sampleSize < MIN_OBSERVATIONS_FOR_POTENTIAL_PATTERN) return 'INSUFFICIENT_DATA';
  if (groupAverage == null || baselineAverage == null || baselineAverage === 0) return 'INSUFFICIENT_DATA';

  const relativeDelta = (groupAverage - baselineAverage) / baselineAverage;
  if (relativeDelta >= DIRECTION_RELATIVE_MARGIN) return 'PROMISING';
  if (relativeDelta <= -DIRECTION_RELATIVE_MARGIN) return 'UNDERPERFORMING';
  return 'NEUTRAL';
}
