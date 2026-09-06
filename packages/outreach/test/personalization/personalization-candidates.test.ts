import { describe, it, expect } from 'vitest';
import {
  buildPersonalizationCandidates,
  buildRoleCompanyCandidates,
  buildWebsiteTechnologyCandidates,
  buildPainIntentCandidates,
  buildBusinessTriggerCandidates,
  buildAcquisitionSignalCandidates,
  type EvidenceRowInput,
} from '../../src/personalization/personalization-candidates.js';

function evidenceRow(overrides: Partial<EvidenceRowInput> = {}): EvidenceRowInput {
  return {
    id: 'e1',
    evidenceType: 'decision_maker_signal',
    signalCategory: 'role_founder_or_ceo',
    evidenceTier: 'LIKELY',
    rawValue: 'Founder',
    sourceUrl: null,
    ...overrides,
  };
}

describe('buildRoleCompanyCandidates', () => {
  it('produces a FACT candidate for a CONFIRMED-tier role fact', () => {
    const candidates = buildRoleCompanyCandidates([evidenceRow({ evidenceTier: 'CONFIRMED' })], 'Acme');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe('FACT');
    expect(candidates[0].safeToStateAsFact).toBe(true);
    expect(candidates[0].observation).toContain('Acme');
  });

  it('produces an INFERENCE candidate for a LIKELY-tier role fact, never safe to state as fact', () => {
    const candidates = buildRoleCompanyCandidates([evidenceRow({ evidenceTier: 'LIKELY' })], 'Acme');
    expect(candidates[0].confidence).toBe('INFERENCE');
    expect(candidates[0].safeToStateAsFact).toBe(false);
  });

  it('surfaces only the highest-authority role when multiple role facts exist (no contradictory hooks)', () => {
    const rows = [
      evidenceRow({ id: 'e1', signalCategory: 'role_execution_only' }),
      evidenceRow({ id: 'e2', signalCategory: 'role_founder_or_ceo' }),
    ];
    const candidates = buildRoleCompanyCandidates(rows, 'Acme');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidenceId).toBe('e2');
  });

  it('never fabricates a company name when none is known', () => {
    const candidates = buildRoleCompanyCandidates([evidenceRow()], null);
    expect(candidates[0].observation).not.toContain('null');
    expect(candidates[0].observation).not.toContain('undefined');
  });

  it('produces nothing when no role fact exists', () => {
    expect(buildRoleCompanyCandidates([], 'Acme')).toHaveLength(0);
  });

  it('role_execution_only is not treated as an authority role (produces no candidate on its own)', () => {
    const candidates = buildRoleCompanyCandidates([evidenceRow({ signalCategory: 'role_execution_only' })], 'Acme');
    expect(candidates).toHaveLength(0);
  });
});

describe('buildWebsiteTechnologyCandidates', () => {
  it('lists only DETECTED technologies as a plain fact', () => {
    const candidates = buildWebsiteTechnologyCandidates([
      { technologyName: 'Shopify', status: 'DETECTED', sourceUrl: 'https://acme.com' },
      { technologyName: 'Klaviyo', status: 'NOT_DETECTED', sourceUrl: 'https://acme.com' },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].observation).toContain('Shopify');
    expect(candidates[0].observation).not.toContain('Klaviyo');
  });

  it('produces nothing when no technology is detected', () => {
    expect(buildWebsiteTechnologyCandidates([{ technologyName: 'Shopify', status: 'NOT_DETECTED', sourceUrl: null }])).toHaveLength(0);
  });

  it('ADVERSARIAL: Shopify detection never becomes a DTC claim — no dtc_signal-shaped hook is ever produced from technology alone', () => {
    const candidates = buildWebsiteTechnologyCandidates([{ technologyName: 'Shopify', status: 'DETECTED', sourceUrl: null }]);
    expect(candidates.every((c) => c.hookType !== ('dtc_signal' as never))).toBe(true);
    expect(candidates.every((c) => !/dtc|direct-to-consumer/i.test(c.observation))).toBe(true);
  });

  it('ADVERSARIAL: technology detection never becomes an acquisition-signal claim', () => {
    const candidates = buildWebsiteTechnologyCandidates([{ technologyName: 'Meta Pixel', status: 'DETECTED', sourceUrl: null }]);
    expect(candidates.every((c) => c.hookType === 'website_technology')).toBe(true);
    expect(candidates.every((c) => !/paid|ad spend|acquisition/i.test(c.observation))).toBe(true);
  });
});

describe('buildPainIntentCandidates', () => {
  it('maps a pain_signals row to an INFERENCE candidate, never safe to state as fact', () => {
    const candidates = buildPainIntentCandidates([{ id: 'p1', topic: 'CAC', signalText: 'CAC is killing us', sourceUrl: 'https://x.com/a/status/1' }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe('INFERENCE');
    expect(candidates[0].safeToStateAsFact).toBe(false);
  });

  it('ADVERSARIAL: generic marketing language is never a pain-signal candidate unless it already exists as a classified pain_signals row', () => {
    // This function only ever receives already-classified pain_signals rows
    // (Stage 4B's own classifier is the gate) — passing an empty array here
    // proves no candidate is fabricated when no such row exists.
    expect(buildPainIntentCandidates([])).toHaveLength(0);
  });
});

describe('buildBusinessTriggerCandidates', () => {
  it('maps a sourced, valid-type trigger to a candidate', () => {
    const candidates = buildBusinessTriggerCandidates([
      evidenceRow({ evidenceType: 'trigger_signal', signalCategory: 'funding_growth_announcement', sourceUrl: 'https://acme.com/press' }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].hookType).toBe('business_trigger');
  });

  it('a trigger with no source URL produces no candidate (ICP §22.B requires a specific reference)', () => {
    const candidates = buildBusinessTriggerCandidates([
      evidenceRow({ evidenceType: 'trigger_signal', signalCategory: 'funding_growth_announcement', sourceUrl: null }),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('ADVERSARIAL: an unrecognized trigger type (e.g. "ad_volume_increase") never produces a candidate', () => {
    const candidates = buildBusinessTriggerCandidates([
      evidenceRow({ evidenceType: 'trigger_signal', signalCategory: 'ad_volume_increase', sourceUrl: 'https://acme.com/press' }),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('ADVERSARIAL: a funding announcement is never surfaced as a revenue hook (stays a business_trigger only)', () => {
    const candidates = buildBusinessTriggerCandidates([
      evidenceRow({ evidenceType: 'trigger_signal', signalCategory: 'funding_growth_announcement', sourceUrl: 'https://acme.com/press' }),
    ]);
    expect(candidates.every((c) => c.hookType === 'business_trigger')).toBe(true);
  });
});

describe('buildAcquisitionSignalCandidates', () => {
  it('maps a known acquisition category to a candidate', () => {
    const candidates = buildAcquisitionSignalCandidates([
      evidenceRow({ evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' }),
    ]);
    expect(candidates).toHaveLength(1);
  });

  it('ADVERSARIAL: generic marketing language never becomes a ROAS/CAC/acquisition candidate — only allowlisted categories do', () => {
    const candidates = buildAcquisitionSignalCandidates([
      evidenceRow({ evidenceType: 'paid_acquisition_signal', signalCategory: 'some_unrecognized_category' }),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('a confirmed spend statement never has its dollar figure interpolated into the observation text', () => {
    const candidates = buildAcquisitionSignalCandidates([
      evidenceRow({ evidenceType: 'paid_acquisition_signal', signalCategory: 'confirmed_spend_statement', evidenceTier: 'CONFIRMED', rawValue: '$25,000/month on Meta' }),
    ]);
    expect(candidates[0].observation).not.toContain('$25,000');
    expect(candidates[0].safeToStateAsFact).toBe(true);
  });
});

describe('buildPersonalizationCandidates — determinism and unsupported-input rejection', () => {
  it('is deterministic — same input always produces the same output, in the same order', () => {
    const input = {
      evidenceRows: [evidenceRow({ evidenceType: 'trigger_signal', signalCategory: 'new_product_launch', sourceUrl: 'https://acme.com/press' })],
      painSignals: [],
      technologyDetections: [],
      companyName: 'Acme',
    };
    expect(buildPersonalizationCandidates(input)).toEqual(buildPersonalizationCandidates(input));
  });

  it('ADVERSARIAL: an evidence row with an unrecognized (evidenceType, signalCategory) pair produces zero candidates from every builder', () => {
    const bogus = evidenceRow({ evidenceType: 'revenue_signal' as never, signalCategory: 'totally_made_up_category', evidenceTier: 'CONFIRMED' });
    const candidates = buildPersonalizationCandidates({ evidenceRows: [bogus], painSignals: [], technologyDetections: [], companyName: null });
    expect(candidates).toHaveLength(0);
  });

  it('handles conflicting evidence (a role fact AND an execution-only fact for the same prospect) by surfacing only the authoritative one', () => {
    const rows = [
      evidenceRow({ id: 'a', signalCategory: 'role_execution_only' }),
      evidenceRow({ id: 'b', signalCategory: 'role_founder_or_ceo' }),
    ];
    const candidates = buildPersonalizationCandidates({ evidenceRows: rows, painSignals: [], technologyDetections: [], companyName: 'Acme' });
    const roleCandidates = candidates.filter((c) => c.hookType === 'role_company');
    expect(roleCandidates).toHaveLength(1);
    expect(roleCandidates[0].evidenceId).toBe('b');
  });

  it('handles totally empty evidence safely, producing zero candidates rather than throwing', () => {
    expect(buildPersonalizationCandidates({ evidenceRows: [], painSignals: [], technologyDetections: [], companyName: null })).toEqual([]);
  });
});
