import { describe, it, expect } from 'vitest';
import { classifyPainCategory, isPainTaxonomyCategory, PAIN_TAXONOMY_CATEGORIES } from '../../src/pain-taxonomy/pain-taxonomy.js';

describe('classifyPainCategory', () => {
  it('classifies CAC', () => {
    expect(classifyPainCategory('our CAC has doubled this quarter')).toBe('CAC');
  });

  it('classifies ROAS', () => {
    expect(classifyPainCategory('blended ROAS looks great but something feels off')).toBe('ROAS');
  });

  it('classifies MER', () => {
    expect(classifyPainCategory('tracking marketing efficiency ratio weekly now')).toBe('MER');
  });

  it('classifies attribution', () => {
    expect(classifyPainCategory('multi-touch attribution never matches what Meta reports')).toBe('attribution');
  });

  it('classifies budget_allocation', () => {
    expect(classifyPainCategory('how do you decide channel mix for next quarter')).toBe('budget_allocation');
  });

  it('classifies profitability', () => {
    expect(classifyPainCategory('contribution margin keeps shrinking as we scale')).toBe('profitability');
  });

  it('falls back to other rather than guessing', () => {
    expect(classifyPainCategory('excited to announce our new office space')).toBe('other');
  });

  it('is deterministic', () => {
    const text = 'CAC and ROAS are both climbing';
    expect(classifyPainCategory(text)).toBe(classifyPainCategory(text));
  });
});

describe('isPainTaxonomyCategory', () => {
  it('accepts every declared category', () => {
    for (const c of PAIN_TAXONOMY_CATEGORIES) expect(isPainTaxonomyCategory(c)).toBe(true);
  });

  it('rejects an unknown string', () => {
    expect(isPainTaxonomyCategory('not-a-category')).toBe(false);
  });
});
