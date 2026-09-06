import { describe, it, expect } from 'vitest';
import { firstNameFrom, renderMessageDraft } from '../../src/drafts/message-templates.js';
import type { PersonalizationCandidate } from '../../src/personalization/personalization-candidates.js';

function candidate(overrides: Partial<PersonalizationCandidate> = {}): PersonalizationCandidate {
  return {
    hookType: 'role_company',
    observation: 'Founder/CEO at Acme',
    sourceUrl: null,
    evidenceId: 'e1',
    confidence: 'FACT',
    evidenceTier: 'CONFIRMED',
    whyRelevant: 'authority',
    safeToStateAsFact: true,
    ...overrides,
  };
}

describe('firstNameFrom', () => {
  it('extracts the first token of a display name', () => {
    expect(firstNameFrom('Jane Founder')).toBe('Jane');
  });

  it('falls back to "there" for an empty/missing name', () => {
    expect(firstNameFrom('')).toBe('there');
    expect(firstNameFrom(null)).toBe('there');
    expect(firstNameFrom(undefined)).toBe('there');
  });

  it('handles a single-word name', () => {
    expect(firstNameFrom('Cher')).toBe('Cher');
  });
});

describe('renderMessageDraft', () => {
  it('renders a safe, fully generic message when no candidate is selected', () => {
    const text = renderMessageDraft('Jane Founder', 'Acme', null);
    expect(text).toContain('Jane');
    expect(text).toContain('Acme');
    expect(text.length).toBeGreaterThan(0);
  });

  it('handles empty personalization AND missing company/name safely', () => {
    const text = renderMessageDraft(null, null, null);
    expect(text).toContain('there');
    expect(text).toContain('your company');
  });

  it('renders one message per hook type deterministically', () => {
    const hookTypes: PersonalizationCandidate['hookType'][] = ['role_company', 'website_technology', 'pain_intent', 'business_trigger', 'acquisition_signal'];
    for (const hookType of hookTypes) {
      const text = renderMessageDraft('Jane', 'Acme', candidate({ hookType }));
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic — same inputs always produce the same message', () => {
    const c = candidate();
    expect(renderMessageDraft('Jane', 'Acme', c)).toBe(renderMessageDraft('Jane', 'Acme', c));
  });

  it('ADVERSARIAL: never interpolates a raw evidence rawValue/dollar figure into the rendered text', () => {
    const c = candidate({ hookType: 'acquisition_signal', observation: 'has disclosed a specific paid-spend figure in a primary source' });
    const text = renderMessageDraft('Jane', 'Acme', c);
    expect(text).not.toMatch(/\$[\d,]+/);
  });

  it('never includes the literal word "null" or "undefined" for missing fields', () => {
    const text = renderMessageDraft(undefined, null, null);
    expect(text.toLowerCase()).not.toContain('null');
    expect(text.toLowerCase()).not.toContain('undefined');
  });
});
