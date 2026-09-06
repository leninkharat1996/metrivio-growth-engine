import { describe, it, expect } from 'vitest';
import { classifyFounderCandidate } from '../../src/discovery/founder-classifier.js';

describe('classifyFounderCandidate', () => {
  it('founder profile: classifies "Founder @ExampleStore" as founder_or_ceo', () => {
    const result = classifyFounderCandidate('Founder @ExampleStore. Building DTC skincare.');
    expect(result.roleDetected).toBe(true);
    expect(result.normalizedRole).toBe('founder_or_ceo');
    expect(result.evidenceTier).toBe('LIKELY');
  });

  it('CEO profile: classifies "CEO of Example Inc" as founder_or_ceo', () => {
    const result = classifyFounderCandidate('CEO of Example Inc, DTC skincare brand.');
    expect(result.normalizedRole).toBe('founder_or_ceo');
  });

  it('owner profile: classifies "Owner" as founder_or_ceo', () => {
    const result = classifyFounderCandidate('Owner, Example Coffee Co.');
    expect(result.normalizedRole).toBe('founder_or_ceo');
  });

  it('co-founder variants (with and without hyphen) both match', () => {
    expect(classifyFounderCandidate('Co-founder @Brand').normalizedRole).toBe('founder_or_ceo');
    expect(classifyFounderCandidate('Cofounder @Brand').normalizedRole).toBe('founder_or_ceo');
  });

  it('ordinary employee profile: an execution-only title classifies as execution_only, not founder', () => {
    const result = classifyFounderCandidate('Marketing Coordinator at Example Brand');
    expect(result.roleDetected).toBe(true);
    expect(result.normalizedRole).toBe('execution_only');
  });

  it('avoids the false positive of "assistant to the founder"', () => {
    const result = classifyFounderCandidate('Assistant to the Founder at Example Brand');
    expect(result.normalizedRole).toBe('execution_only');
  });

  it('avoids the false positive of "founder\'s coordinator"', () => {
    const result = classifyFounderCandidate("Founder's coordinator, Example Brand");
    expect(result.normalizedRole).toBe('execution_only');
  });

  it('director with a marketing/growth title classifies as director_with_authority_signal', () => {
    const result = classifyFounderCandidate('VP of Growth at Example Brand');
    expect(result.normalizedRole).toBe('director_with_authority_signal');
  });

  it('a marketing-adjacent title with no seniority signal classifies as other_marketing_adjacent', () => {
    const result = classifyFounderCandidate('Growth marketer, ecommerce nerd');
    expect(result.normalizedRole).toBe('other_marketing_adjacent');
  });

  it('an empty/missing bio returns roleDetected: false (unknown, not execution_only)', () => {
    expect(classifyFounderCandidate('').roleDetected).toBe(false);
    expect(classifyFounderCandidate(undefined).roleDetected).toBe(false);
    expect(classifyFounderCandidate(null).roleDetected).toBe(false);
  });

  it('a bio with no role vocabulary at all returns roleDetected: false', () => {
    const result = classifyFounderCandidate('Coffee, dogs, and long walks on the beach.');
    expect(result.roleDetected).toBe(false);
    expect(result.normalizedRole).toBeNull();
  });

  it('does not false-positive on an unrelated word merely containing role-like characters', () => {
    // "confounder" (a statistics term) must not match "founder" as a substring.
    const result = classifyFounderCandidate('Data scientist studying confounder variables in trials.');
    expect(result.roleDetected).toBe(false);
  });

  it('is deterministic: the same bio always classifies identically', () => {
    const bio = 'Founder @ExampleStore.';
    const results = Array.from({ length: 5 }, () => classifyFounderCandidate(bio));
    for (const r of results) expect(r).toEqual(results[0]);
  });
});
