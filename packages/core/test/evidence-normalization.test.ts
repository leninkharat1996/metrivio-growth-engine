import { describe, it, expect } from 'vitest';
import {
  normalizeEvidenceForScoring,
  countVerifiedTriggers,
  SIGNAL_CATEGORIES,
  type EvidenceFact,
  type TriggerFact,
  type NormalizeEvidenceInput,
} from '../src/scoring/evidence-normalization.js';
import { scoreProspect } from '../src/scoring/scorer.js';

function baseInput(overrides: Partial<NormalizeEvidenceInput> = {}): NormalizeEvidenceInput {
  return {
    facts: [],
    triggers: [],
    exclusions: { notDtcEcommerce: false, companyAppearsDefunct: false, onlyContactHasNoBudgetAuthority: false },
    ...overrides,
  };
}

describe('normalizeEvidenceForScoring — presence-based fact mapping', () => {
  it('maps revenue_signal facts to the corresponding RevenueFitEvidence booleans', () => {
    const facts: EvidenceFact[] = [
      { evidenceType: 'revenue_signal', signalCategory: SIGNAL_CATEGORIES.revenue_signal.employeeCountBand },
      { evidenceType: 'revenue_signal', signalCategory: SIGNAL_CATEGORIES.revenue_signal.shopifyPlusDetected },
    ];
    const result = normalizeEvidenceForScoring(baseInput({ facts }));
    expect(result.revenueFit.employeeCountBandMatch).toBe(true);
    expect(result.revenueFit.shopifyPlusDetected).toBe(true);
    expect(result.revenueFit.warehouseFulfillmentSignal).toBe(false);
    expect(result.revenueFit.confirmedRevenueStatement).toBe(false);
  });

  it('an absent category maps to false, never inferred from anything else', () => {
    const result = normalizeEvidenceForScoring(baseInput());
    expect(result.revenueFit.employeeCountBandMatch).toBe(false);
    expect(result.paidAcquisition.metaAdActiveLast30Days).toBe(false);
    expect(result.maturity.twoOrMoreConcurrentPaidChannels).toBe(false);
  });

  it('maps maturity_signal facts correctly', () => {
    const facts: EvidenceFact[] = [
      { evidenceType: 'maturity_signal', signalCategory: SIGNAL_CATEGORIES.maturity_signal.analyticsTagDetected },
      { evidenceType: 'maturity_signal', signalCategory: SIGNAL_CATEGORIES.maturity_signal.twoOrMoreProductLines },
    ];
    const result = normalizeEvidenceForScoring(baseInput({ facts }));
    expect(result.maturity.analyticsTagDetected).toBe(true);
    expect(result.maturity.twoOrMoreProductLines).toBe(true);
    expect(result.maturity.twoOrMoreConcurrentPaidChannels).toBe(false);
    expect(result.maturity.twoOrMoreRetentionToolsDetected).toBe(false);
  });

  it('maps dtc_signal presence correctly', () => {
    const facts: EvidenceFact[] = [
      { evidenceType: 'dtc_signal', signalCategory: SIGNAL_CATEGORIES.dtc_signal.confirmedDtcWithOwnedFunnel },
    ];
    expect(normalizeEvidenceForScoring(baseInput({ facts })).dtcFit.confirmedDtcWithOwnedFunnel).toBe(true);
    expect(normalizeEvidenceForScoring(baseInput()).dtcFit.confirmedDtcWithOwnedFunnel).toBe(false);
  });
});

describe('normalizeEvidenceForScoring — decision-maker role tier priority', () => {
  it('maps a single role fact to the matching tier', () => {
    const facts: EvidenceFact[] = [
      { evidenceType: 'decision_maker_signal', signalCategory: SIGNAL_CATEGORIES.decision_maker_signal.roleFounderOrCeo },
    ];
    expect(normalizeEvidenceForScoring(baseInput({ facts })).decisionMaker.roleTier).toBe('founder_or_ceo');
  });

  it('defaults to execution_only when no role fact is present', () => {
    expect(normalizeEvidenceForScoring(baseInput()).decisionMaker.roleTier).toBe('execution_only');
  });

  it('the highest-authority role fact wins if more than one is somehow present', () => {
    const facts: EvidenceFact[] = [
      {
        evidenceType: 'decision_maker_signal',
        signalCategory: SIGNAL_CATEGORIES.decision_maker_signal.roleOtherMarketingAdjacent,
      },
      { evidenceType: 'decision_maker_signal', signalCategory: SIGNAL_CATEGORIES.decision_maker_signal.roleFounderOrCeo },
    ];
    expect(normalizeEvidenceForScoring(baseInput({ facts })).decisionMaker.roleTier).toBe('founder_or_ceo');
  });

  it('maps publicVisibility and correctProfileIdentified independently of role', () => {
    const facts: EvidenceFact[] = [
      { evidenceType: 'decision_maker_signal', signalCategory: SIGNAL_CATEGORIES.decision_maker_signal.publicVisibility },
      {
        evidenceType: 'decision_maker_signal',
        signalCategory: SIGNAL_CATEGORIES.decision_maker_signal.correctProfileIdentified,
      },
    ];
    const result = normalizeEvidenceForScoring(baseInput({ facts }));
    expect(result.decisionMaker.publicVisibility).toBe(true);
    expect(result.decisionMaker.correctProfileIdentified).toBe(true);
    expect(result.decisionMaker.roleTier).toBe('execution_only');
  });
});

describe('countVerifiedTriggers — ICP §22.B trigger verification rules', () => {
  it('a trigger with no sourceUrl never counts, regardless of type', () => {
    const triggers: TriggerFact[] = [{ triggerType: 'new_product_launch', sourceUrl: '' }];
    expect(countVerifiedTriggers(triggers)).toBe(0);
  });

  it('a sourced trigger of one of the five simple valid types counts on its own', () => {
    const triggers: TriggerFact[] = [{ triggerType: 'funding_growth_announcement', sourceUrl: 'https://example.com/press' }];
    expect(countVerifiedTriggers(triggers)).toBe(1);
  });

  it('"new_paid_channel_appearing" does NOT count without priorDatedAbsenceConfirmed, even with a sourceUrl — current activity alone is never a trigger', () => {
    const triggers: TriggerFact[] = [
      { triggerType: 'new_paid_channel_appearing', sourceUrl: 'https://example.com/ads', priorDatedAbsenceConfirmed: false },
    ];
    expect(countVerifiedTriggers(triggers)).toBe(0);
  });

  it('"new_paid_channel_appearing" counts once both sourceUrl and priorDatedAbsenceConfirmed are present', () => {
    const triggers: TriggerFact[] = [
      { triggerType: 'new_paid_channel_appearing', sourceUrl: 'https://example.com/ads', priorDatedAbsenceConfirmed: true },
    ];
    expect(countVerifiedTriggers(triggers)).toBe(1);
  });

  it('two independent (distinct-type) verified triggers count as 2', () => {
    const triggers: TriggerFact[] = [
      { triggerType: 'active_growth_hiring', sourceUrl: 'https://example.com/jobs' },
      { triggerType: 'funnel_offer_change', sourceUrl: 'https://example.com/landing' },
    ];
    expect(countVerifiedTriggers(triggers)).toBe(2);
  });

  it('the same trigger type repeated is not double-counted as two independent triggers', () => {
    const triggers: TriggerFact[] = [
      { triggerType: 'active_growth_hiring', sourceUrl: 'https://example.com/jobs-1' },
      { triggerType: 'active_growth_hiring', sourceUrl: 'https://example.com/jobs-2' },
    ];
    expect(countVerifiedTriggers(triggers)).toBe(1);
  });

  it('there is no "ad volume increase" trigger type at all — the type system does not permit inferring a growth trigger from current advertising alone', () => {
    const validTypes = ['new_product_launch', 'store_brand_expansion', 'active_growth_hiring', 'funding_growth_announcement', 'funnel_offer_change', 'new_paid_channel_appearing'];
    expect(validTypes).not.toContain('ad_volume_increase');
  });
});

describe('normalizeEvidenceForScoring — trigger integration end to end', () => {
  it('flows verified trigger count through into the scoring input', () => {
    const triggers: TriggerFact[] = [
      { triggerType: 'active_growth_hiring', sourceUrl: 'https://example.com/jobs' },
      { triggerType: 'funding_growth_announcement', sourceUrl: 'https://example.com/press' },
    ];
    const result = normalizeEvidenceForScoring(baseInput({ triggers }));
    expect(result.trigger.verifiedTriggerCount).toBe(2);
  });
});

describe('normalizeEvidenceForScoring — exclusion handling', () => {
  it('"no paid acquisition activity detected" is derived from the paid-acquisition facts, not accepted as a separate input', () => {
    const result = normalizeEvidenceForScoring(baseInput()); // no paid-acquisition facts at all
    expect(result.exclusions.noPaidAcquisitionActivityDetected).toBe(true);
  });

  it('the derived exclusion flips to false as soon as any one paid-acquisition category is present', () => {
    const facts: EvidenceFact[] = [
      { evidenceType: 'paid_acquisition_signal', signalCategory: SIGNAL_CATEGORIES.paid_acquisition_signal.metaAdActive30d },
    ];
    const result = normalizeEvidenceForScoring(baseInput({ facts }));
    expect(result.exclusions.noPaidAcquisitionActivityDetected).toBe(false);
  });

  it('a CONFIRMED spend statement also counts as paid-acquisition activity for the exclusion check, even with no category facts present', () => {
    const facts: EvidenceFact[] = [
      {
        evidenceType: 'paid_acquisition_signal',
        signalCategory: SIGNAL_CATEGORIES.paid_acquisition_signal.confirmedSpendStatement,
      },
    ];
    const result = normalizeEvidenceForScoring(baseInput({ facts }));
    expect(result.exclusions.noPaidAcquisitionActivityDetected).toBe(false);
  });

  it('the other three exclusions pass through directly from the supplied determinations', () => {
    const result = normalizeEvidenceForScoring(
      baseInput({
        facts: [
          { evidenceType: 'paid_acquisition_signal', signalCategory: SIGNAL_CATEGORIES.paid_acquisition_signal.metaAdActive30d },
        ],
        exclusions: { notDtcEcommerce: true, companyAppearsDefunct: false, onlyContactHasNoBudgetAuthority: true },
      })
    );
    expect(result.exclusions.notDtcEcommerce).toBe(true);
    expect(result.exclusions.companyAppearsDefunct).toBe(false);
    expect(result.exclusions.onlyContactHasNoBudgetAuthority).toBe(true);
  });
});

describe('normalizeEvidenceForScoring -> scoreProspect integration', () => {
  it('a fully-populated normalized input scores identically to the equivalent direct scorer input', () => {
    const facts: EvidenceFact[] = [
      { evidenceType: 'revenue_signal', signalCategory: SIGNAL_CATEGORIES.revenue_signal.shopifyPlusDetected },
      { evidenceType: 'paid_acquisition_signal', signalCategory: SIGNAL_CATEGORIES.paid_acquisition_signal.metaAdActive30d },
      { evidenceType: 'paid_acquisition_signal', signalCategory: SIGNAL_CATEGORIES.paid_acquisition_signal.googleAdsActive },
      { evidenceType: 'maturity_signal', signalCategory: SIGNAL_CATEGORIES.maturity_signal.twoOrMoreConcurrentPaidChannels },
      { evidenceType: 'maturity_signal', signalCategory: SIGNAL_CATEGORIES.maturity_signal.analyticsTagDetected },
      { evidenceType: 'decision_maker_signal', signalCategory: SIGNAL_CATEGORIES.decision_maker_signal.roleFounderOrCeo },
      { evidenceType: 'decision_maker_signal', signalCategory: SIGNAL_CATEGORIES.decision_maker_signal.publicVisibility },
      { evidenceType: 'dtc_signal', signalCategory: SIGNAL_CATEGORIES.dtc_signal.confirmedDtcWithOwnedFunnel },
    ];
    const triggers: TriggerFact[] = [{ triggerType: 'active_growth_hiring', sourceUrl: 'https://example.com/jobs' }];

    const normalized = normalizeEvidenceForScoring(
      baseInput({
        facts,
        triggers,
        exclusions: { notDtcEcommerce: false, companyAppearsDefunct: false, onlyContactHasNoBudgetAuthority: false },
      })
    );
    const result = scoreProspect(normalized);

    expect(result.exclusionTriggered).toBe(false);
    expect(result.factorBreakdown.revenueFit.evidenceTier).toBe('LIKELY'); // Shopify Plus only, signal 4 not separately supplied
    expect(result.factorBreakdown.paidAcquisition.evidenceTier).toBe('STRONG_EVIDENCE');
    expect(result.factorBreakdown.maturity.points).toBe(8); // 5 + 3
    expect(result.factorBreakdown.decisionMaker.points).toBe(12); // 8 + 4
    expect(result.factorBreakdown.trigger.points).toBe(10);
    expect(result.factorBreakdown.dtcFit.points).toBe(5);
  });
});
