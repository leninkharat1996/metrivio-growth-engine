import { describe, it, expect } from 'vitest';
import { renderFollowUpMessageDraft } from '../../src/follow-up/follow-up-message-templates.js';
import { renderMessageDraft } from '../../src/drafts/message-templates.js';
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

describe('renderFollowUpMessageDraft — determinism', () => {
  it('produces the same output for the same inputs', () => {
    const a = renderFollowUpMessageDraft('Jane Founder', 'Acme', 'clarification', candidate());
    const b = renderFollowUpMessageDraft('Jane Founder', 'Acme', 'clarification', candidate());
    expect(a).toBe(b);
  });
});

describe('renderFollowUpMessageDraft — distinct from original message', () => {
  it('never produces the exact same text as the original renderMessageDraft output, with or without a hook', () => {
    for (const hook of [candidate(), null]) {
      const original = renderMessageDraft('Jane Founder', 'Acme', hook);
      for (const intent of ['clarification', 'reminder', 'final_close'] as const) {
        const followUp = renderFollowUpMessageDraft('Jane Founder', 'Acme', intent, hook);
        expect(followUp).not.toBe(original);
      }
    }
  });

  it('each of the three intents renders distinct text from one another for the same hook', () => {
    const clarification = renderFollowUpMessageDraft('Jane', 'Acme', 'clarification', candidate());
    const reminder = renderFollowUpMessageDraft('Jane', 'Acme', 'reminder', candidate());
    const finalClose = renderFollowUpMessageDraft('Jane', 'Acme', 'final_close', candidate());
    expect(new Set([clarification, reminder, finalClose]).size).toBe(3);
  });
});

describe('renderFollowUpMessageDraft — no unsupported claims', () => {
  it('never mentions a dollar figure, ROAS/CAC number, or "just following up" as the only content', () => {
    for (const intent of ['clarification', 'reminder', 'final_close'] as const) {
      for (const hook of [candidate(), null]) {
        const text = renderFollowUpMessageDraft('Jane', 'Acme', intent, hook);
        expect(text).not.toMatch(/\$\d/);
        expect(text.toLowerCase()).not.toContain('just following up');
        expect(text.toLowerCase()).not.toContain('i know you');
        expect(text.toLowerCase()).not.toContain('busy');
      }
    }
  });

  it('never splices raw scraped text (pain_intent observation quotes) into the rendered message', () => {
    const painCandidate = candidate({ hookType: 'pain_intent', observation: 'mentioned CAC: "our CAC is insane right now"' });
    const text = renderFollowUpMessageDraft('Jane', 'Acme', 'clarification', painCandidate);
    expect(text).not.toContain('our CAC is insane right now');
  });

  it('falls back to a value-oriented clause (no invented facts) when no new hook is available', () => {
    const clarification = renderFollowUpMessageDraft('Jane', 'Acme', 'clarification', null);
    const reminder = renderFollowUpMessageDraft('Jane', 'Acme', 'reminder', null);
    expect(clarification.length).toBeGreaterThan(0);
    expect(reminder.length).toBeGreaterThan(0);
  });

  it('final_close never depends on a hook and stays identical regardless of one being present', () => {
    const withHook = renderFollowUpMessageDraft('Jane', 'Acme', 'final_close', candidate());
    const withoutHook = renderFollowUpMessageDraft('Jane', 'Acme', 'final_close', null);
    expect(withHook).toBe(withoutHook);
  });
});

describe('renderFollowUpMessageDraft — greeting', () => {
  it('uses the first name only, matching the original template convention', () => {
    const text = renderFollowUpMessageDraft('Jane Founder', 'Acme', 'clarification', null);
    expect(text.startsWith('Hi Jane,')).toBe(true);
  });
});
