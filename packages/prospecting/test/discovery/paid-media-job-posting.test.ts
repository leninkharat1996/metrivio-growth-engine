import { describe, it, expect } from 'vitest';
import { classifyPaidMediaJobPosting } from '../../src/discovery/paid-media-job-posting.js';

const NOW = new Date('2026-09-05T00:00:00.000Z');
const recent = '2026-08-01T00:00:00.000Z'; // 35 days before NOW
const old = '2026-01-01T00:00:00.000Z'; // well over 90 days before NOW

describe('classifyPaidMediaJobPosting', () => {
  it('qualifies: an explicit paid-media title + hiring language + within 90 days', () => {
    const result = classifyPaidMediaJobPosting('We are hiring a Media Buyer to join our growing team!', recent, NOW);
    expect(result.qualifies).toBe(true);
    expect(result.matchedPhrase).toMatch(/media buyer/i);
  });

  it('a generic "we\'re hiring" tweet with no paid-media title does not qualify', () => {
    const result = classifyPaidMediaJobPosting("We're hiring! Join our team.", recent, NOW);
    expect(result.qualifies).toBe(false);
    expect(result.reason).toMatch(/generic hiring tweet/);
  });

  it('hiring for a non-paid-media role (e.g. a generic "marketer") does not qualify', () => {
    const result = classifyPaidMediaJobPosting('We are hiring a Marketing Coordinator.', recent, NOW);
    expect(result.qualifies).toBe(false);
  });

  it('a paid-media title mentioned without hiring language does not qualify', () => {
    const result = classifyPaidMediaJobPosting('Shoutout to our media buyer for crushing it this month.', recent, NOW);
    expect(result.qualifies).toBe(false);
    expect(result.reason).toMatch(/no explicit hiring language/);
  });

  it('a qualifying title+language older than 90 days does not qualify', () => {
    const result = classifyPaidMediaJobPosting('Now hiring: Growth Marketer, paid social focus.', old, NOW);
    expect(result.qualifies).toBe(false);
    expect(result.withinNinetyDays).toBe(false);
  });

  it('a missing/unparseable date does not qualify (cannot verify the 90-day window)', () => {
    const result = classifyPaidMediaJobPosting('Hiring a Media Buyer now.', undefined, NOW);
    expect(result.qualifies).toBe(false);
    expect(result.withinNinetyDays).toBeNull();
  });

  it('is deterministic given the same inputs and a fixed "now"', () => {
    const text = 'Hiring a Paid Social Specialist, apply now.';
    const results = Array.from({ length: 5 }, () => classifyPaidMediaJobPosting(text, recent, NOW));
    for (const r of results) expect(r).toEqual(results[0]);
  });
});
