import { describe, it, expect } from 'vitest';
import { validateContentDraft, checkOriginality } from '../../src/drafts/content-validation.js';

describe('validateContentDraft — fabrication checks', () => {
  it('passes clean, evidence-free educational copy', () => {
    const result = validateContentDraft('Why ROAS can look great while your business gets worse.');
    expect(result.status).toBe('pass');
    expect(result.notes).toEqual([]);
  });

  it('flags a dollar figure', () => {
    const result = validateContentDraft('We helped a brand save $50,000 last quarter.');
    expect(result.status).toBe('flagged');
    expect(result.notes.some((n) => n.includes('dollar figure'))).toBe(true);
  });

  it('flags a percentage figure', () => {
    const result = validateContentDraft('This approach improved conversion by 34%.');
    expect(result.status).toBe('flagged');
  });

  it('flags a ROAS-style multiplier', () => {
    const result = validateContentDraft('We took them from 1.2x to 3.5x ROAS.');
    expect(result.status).toBe('flagged');
  });

  it('flags a client/case-study reference', () => {
    const result = validateContentDraft('Here is a case study from one of our clients.');
    expect(result.status).toBe('flagged');
    expect(result.notes.some((n) => /no verified client case studies/i.test(n))).toBe(true);
  });

  it('flags an unverified outcome claim', () => {
    const result = validateContentDraft('We achieved incredible growth for this brand.');
    expect(result.status).toBe('flagged');
  });

  it('accumulates multiple notes when multiple rules fire', () => {
    const result = validateContentDraft('Our client saw a 200% increase and we generated $10,000 in savings.');
    expect(result.notes.length).toBeGreaterThan(1);
  });
});

describe('checkOriginality', () => {
  it('flags a body containing a long verbatim excerpt from research', () => {
    const excerpt = 'this is a fairly long sentence copied directly from a competitor post about ROAS';
    const result = checkOriginality(`Here is my new post: ${excerpt}`, [excerpt]);
    expect(result.isOriginal).toBe(false);
  });

  it('does not flag a short, coincidental overlap', () => {
    const result = checkOriginality('We talk about ROAS a lot.', ['ROAS is important']);
    expect(result.isOriginal).toBe(true);
  });

  it('passes when there are no source excerpts to compare against', () => {
    const result = checkOriginality('Any text at all', []);
    expect(result.isOriginal).toBe(true);
  });
});

describe('validateContentDraft — originality integration', () => {
  it('flags a draft that copies a stored excerpt verbatim', () => {
    const excerpt = 'this exact phrase should never appear verbatim inside a metrivio draft body';
    const result = validateContentDraft(`New insight: ${excerpt}`, [excerpt]);
    expect(result.status).toBe('flagged');
    expect(result.notes.some((n) => n.includes('verbatim excerpt'))).toBe(true);
  });
});
