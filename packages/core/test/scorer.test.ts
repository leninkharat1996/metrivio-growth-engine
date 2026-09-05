import { describe, it, expect } from 'vitest';
import { scoreProspect, type IcpScoringInput } from '../src/scoring/scorer.js';

/** An input with every signal absent — the baseline every golden example builds on top of via spreads. */
function blankInput(): IcpScoringInput {
  return {
    exclusions: {
      notDtcEcommerce: false,
      noPaidAcquisitionActivityDetected: false,
      companyAppearsDefunct: false,
      onlyContactHasNoBudgetAuthority: false,
    },
    revenueFit: {
      employeeCountBandMatch: false,
      shopifyPlusDetected: false,
      warehouseFulfillmentSignal: false,
      twoOrMorePaidAcquisitionCategoriesPresent: false,
      confirmedRevenueStatement: false,
    },
    paidAcquisition: {
      metaAdActiveLast30Days: false,
      googleAdsActive: false,
      paidMediaJobPostingLast90Days: false,
      namedAgencyClient: false,
      confirmedSpendStatement: false,
    },
    maturity: {
      twoOrMoreConcurrentPaidChannels: false,
      twoOrMoreRetentionToolsDetected: false,
      analyticsTagDetected: false,
      twoOrMoreProductLines: false,
    },
    decisionMaker: { roleTier: 'execution_only', publicVisibility: false, correctProfileIdentified: false },
    trigger: { verifiedTriggerCount: 0 },
    dtcFit: { confirmedDtcWithOwnedFunnel: false },
  };
}

describe('scoreProspect — ICP §22.F golden examples (exact reproduction, not "fixed")', () => {
  it('A-Tier, score 90 (STRONG-evidence path, no confirmed figures)', () => {
    const input = blankInput();
    input.revenueFit.employeeCountBandMatch = true;
    input.revenueFit.shopifyPlusDetected = true;
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.paidAcquisition.googleAdsActive = true;
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true, // Klaviyo & Recharge
      analyticsTagDetected: true, // Pixel
      twoOrMoreProductLines: true,
    };
    input.decisionMaker = { roleTier: 'founder_or_ceo', publicVisibility: true, correctProfileIdentified: true };
    input.trigger.verifiedTriggerCount = 2; // growth-role hiring + new Google channel w/ prior absence
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;

    const result = scoreProspect(input);
    expect(result.factorBreakdown.revenueFit.points).toBe(20);
    expect(result.factorBreakdown.paidAcquisition.points).toBe(20);
    expect(result.factorBreakdown.maturity.points).toBe(15);
    expect(result.factorBreakdown.decisionMaker.points).toBe(15);
    expect(result.factorBreakdown.trigger.points).toBe(15);
    expect(result.factorBreakdown.dtcFit.points).toBe(5);
    expect(result.score).toBe(90);
    expect(result.tier).toBe('A');
    expect(result.revenueDisclosureStatus).toBe('NOT_CONFIRMED');
    expect(result.spendDisclosureStatus).toBe('NOT_CONFIRMED');
  });

  it('A-Tier, score 95 (CONFIRMED revenue, for contrast)', () => {
    const input = blankInput();
    input.revenueFit.confirmedRevenueStatement = true; // founder quoted "just over $4M"
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.paidAcquisition.googleAdsActive = true;
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    input.decisionMaker = { roleTier: 'founder_or_ceo', publicVisibility: true, correctProfileIdentified: true };
    input.trigger.verifiedTriggerCount = 2;
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;

    const result = scoreProspect(input);
    expect(result.factorBreakdown.revenueFit.points).toBe(25);
    expect(result.factorBreakdown.revenueFit.evidenceTier).toBe('CONFIRMED');
    expect(result.factorBreakdown.paidAcquisition.points).toBe(20);
    expect(result.score).toBe(95);
    expect(result.tier).toBe('A');
    expect(result.revenueDisclosureStatus).toBe('CONFIRMED');
    expect(result.spendDisclosureStatus).toBe('NOT_CONFIRMED');
  });

  it('B-Tier, score 83', () => {
    const input = blankInput();
    input.revenueFit.employeeCountBandMatch = true;
    input.revenueFit.shopifyPlusDetected = true;
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.paidAcquisition.paidMediaJobPostingLast90Days = true;
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true, // Klaviyo & Gorgias
      analyticsTagDetected: true, // GA4
      twoOrMoreProductLines: true,
    };
    input.decisionMaker = {
      roleTier: 'director_with_authority_signal',
      publicVisibility: true,
      correctProfileIdentified: true,
    };
    input.trigger.verifiedTriggerCount = 1; // growth-role job posting, 60 days
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;

    const result = scoreProspect(input);
    expect(result.factorBreakdown.revenueFit.points).toBe(20);
    expect(result.factorBreakdown.paidAcquisition.points).toBe(20);
    expect(result.factorBreakdown.maturity.points).toBe(15);
    expect(result.factorBreakdown.decisionMaker.points).toBe(13);
    expect(result.factorBreakdown.trigger.points).toBe(10);
    expect(result.factorBreakdown.dtcFit.points).toBe(5);
    expect(result.score).toBe(83);
    expect(result.tier).toBe('B');
  });

  it('C-Tier, score 63 — the documented arithmetic is preserved exactly, not "fixed"', () => {
    const input = blankInput();
    // Revenue-Fit: Shopify Plus only = 1 category -> LIKELY -> 25 x 0.40 = 10.
    // NOTE: Paid Acquisition below has 2 categories present; per ICP §22.A's
    // literal signal-4 text this would also count toward Revenue-Fit and
    // push it to STRONG EVIDENCE (20) — but the ICP document's own worked
    // example states Revenue-Fit as LIKELY (10) here regardless. This is a
    // genuine contradiction in the finalized ICP document (see scorer.ts's
    // RevenueFitEvidence doc comment and the Stage 3 completion report).
    // twoOrMorePaidAcquisitionCategoriesPresent is left false here
    // specifically so this golden example reproduces the documented 63
    // exactly, per instruction not to "fix" it.
    input.revenueFit.shopifyPlusDetected = true;
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.paidAcquisition.googleAdsActive = true;
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: false, // only 1 retention tool, below the fixed threshold of 2
      analyticsTagDetected: true, // GA4
      twoOrMoreProductLines: false, // single product line
    };
    input.decisionMaker = {
      // ICP §22.F: "Director, no corroborating authority signal (3)" -> other_marketing_adjacent, not director_with_authority_signal.
      roleTier: 'other_marketing_adjacent',
      publicVisibility: true,
      correctProfileIdentified: true,
    };
    input.trigger.verifiedTriggerCount = 1;
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;

    const result = scoreProspect(input);
    expect(result.factorBreakdown.revenueFit.points).toBe(10); // 25 x 0.40
    expect(result.factorBreakdown.revenueFit.evidenceTier).toBe('LIKELY');
    expect(result.factorBreakdown.paidAcquisition.points).toBe(20);
    expect(result.factorBreakdown.maturity.points).toBe(8);
    expect(result.factorBreakdown.decisionMaker.points).toBe(10);
    expect(result.factorBreakdown.trigger.points).toBe(10);
    expect(result.factorBreakdown.dtcFit.points).toBe(5);
    expect(result.score).toBe(63);
    expect(result.tier).toBe('C');
  });

  it('Reject — exclusion override (score not calculated regardless of any positive signal)', () => {
    const input = blankInput();
    input.exclusions.noPaidAcquisitionActivityDetected = true;
    input.exclusions.onlyContactHasNoBudgetAuthority = true;
    // Even with strong positive signals elsewhere, exclusion must still win.
    input.revenueFit.confirmedRevenueStatement = true;
    input.decisionMaker = { roleTier: 'founder_or_ceo', publicVisibility: true, correctProfileIdentified: true };

    const result = scoreProspect(input);
    expect(result.exclusionTriggered).toBe(true);
    expect(result.score).toBeNull();
    expect(result.tier).toBe('Reject');
    expect(result.exclusionReason).toMatch(/no detectable paid acquisition activity/i);
  });

  it('Reject — low score, no exclusion triggered, score 24', () => {
    const input = blankInput();
    // Revenue-Fit: 0 categories present -> UNKNOWN -> 0, hard rule, no partial credit.
    input.paidAcquisition.metaAdActiveLast30Days = true; // 1 category -> LIKELY -> 25 x 0.40 = 10
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: false, // 1 channel only
      twoOrMoreRetentionToolsDetected: false, // 1 retention tool, below threshold
      analyticsTagDetected: true, // GA4 detected
      twoOrMoreProductLines: false, // single product line
    };
    input.decisionMaker = {
      roleTier: 'other_marketing_adjacent', // "Marketing Manager," no corroborating authority signal
      publicVisibility: false,
      correctProfileIdentified: true,
    };
    input.trigger.verifiedTriggerCount = 0;
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;

    const result = scoreProspect(input);
    expect(result.exclusionTriggered).toBe(false);
    expect(result.factorBreakdown.revenueFit.points).toBe(0);
    expect(result.factorBreakdown.revenueFit.evidenceTier).toBe('UNKNOWN');
    expect(result.factorBreakdown.paidAcquisition.points).toBe(10);
    expect(result.factorBreakdown.maturity.points).toBe(3);
    expect(result.factorBreakdown.decisionMaker.points).toBe(6);
    expect(result.factorBreakdown.trigger.points).toBe(0);
    expect(result.factorBreakdown.dtcFit.points).toBe(5);
    expect(result.score).toBe(24);
    expect(result.tier).toBe('Reject');
  });
});

describe('scoreProspect — exclusion behavior', () => {
  it('any single exclusion match overrides an otherwise-perfect score', () => {
    const input = blankInput();
    input.revenueFit.confirmedRevenueStatement = true;
    input.paidAcquisition.confirmedSpendStatement = true;
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    input.decisionMaker = { roleTier: 'founder_or_ceo', publicVisibility: true, correctProfileIdentified: true };
    input.trigger.verifiedTriggerCount = 2;
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;
    input.exclusions.companyAppearsDefunct = true;

    const result = scoreProspect(input);
    expect(result.exclusionTriggered).toBe(true);
    expect(result.score).toBeNull();
    expect(result.tier).toBe('Reject');
  });

  it.each([
    ['notDtcEcommerce', /not dtc\/ecommerce/i],
    ['noPaidAcquisitionActivityDetected', /no detectable paid acquisition/i],
    ['companyAppearsDefunct', /defunct/i],
    ['onlyContactHasNoBudgetAuthority', /no plausible budget authority/i],
  ] as const)('each of the four independent §15 exclusions triggers Reject on its own: %s', (field, reasonPattern) => {
    const input = blankInput();
    input.exclusions[field] = true;
    const result = scoreProspect(input);
    expect(result.exclusionTriggered).toBe(true);
    expect(result.score).toBeNull();
    expect(result.tier).toBe('Reject');
    expect(result.exclusionReason).toMatch(reasonPattern);
  });

  it('the full factor breakdown is still computed even when excluded, for auditability — but never changes the null score/Reject tier', () => {
    const input = blankInput();
    input.exclusions.notDtcEcommerce = true;
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;
    const result = scoreProspect(input);
    expect(result.factorBreakdown.dtcFit.points).toBe(5); // still computed
    expect(result.score).toBeNull(); // but never surfaced as an actual score
    expect(result.tier).toBe('Reject');
  });
});

describe('scoreProspect — evidence-tier multiplier arithmetic', () => {
  it('CONFIRMED always yields the full factor weight regardless of category count', () => {
    const input = blankInput();
    input.revenueFit.confirmedRevenueStatement = true; // 0 of the other 3 categories present
    const result = scoreProspect(input);
    expect(result.factorBreakdown.revenueFit.evidenceTier).toBe('CONFIRMED');
    expect(result.factorBreakdown.revenueFit.points).toBe(25);
  });

  it('STRONG EVIDENCE (2+ categories) is exactly 80% of the factor weight, never upgraded to CONFIRMED by corroboration', () => {
    const input = blankInput();
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.paidAcquisition.googleAdsActive = true;
    input.paidAcquisition.paidMediaJobPostingLast90Days = true;
    input.paidAcquisition.namedAgencyClient = true; // all 4 categories present, still not CONFIRMED
    const result = scoreProspect(input);
    expect(result.factorBreakdown.paidAcquisition.evidenceTier).toBe('STRONG_EVIDENCE');
    expect(result.factorBreakdown.paidAcquisition.points).toBe(20); // 25 x 0.80
  });

  it('LIKELY (exactly 1 category) is exactly 40% of the factor weight', () => {
    const input = blankInput();
    input.revenueFit.warehouseFulfillmentSignal = true;
    const result = scoreProspect(input);
    expect(result.factorBreakdown.revenueFit.evidenceTier).toBe('LIKELY');
    expect(result.factorBreakdown.revenueFit.points).toBe(10); // 25 x 0.40
  });

  it('UNKNOWN (0 categories) is always exactly 0 — no partial credit under any circumstance', () => {
    const input = blankInput();
    const result = scoreProspect(input);
    expect(result.factorBreakdown.revenueFit.evidenceTier).toBe('UNKNOWN');
    expect(result.factorBreakdown.revenueFit.points).toBe(0);
    expect(result.factorBreakdown.paidAcquisition.evidenceTier).toBe('UNKNOWN');
    expect(result.factorBreakdown.paidAcquisition.points).toBe(0);
  });

  it('UNKNOWN evidence is recorded in missingEvidence, not treated as negative evidence (it simply contributes 0, the same as it would for any zero-category factor)', () => {
    const input = blankInput();
    const result = scoreProspect(input);
    expect(result.missingEvidence).toContain('revenueFit');
    expect(result.missingEvidence).toContain('paidAcquisition');
    // Checklist factors have no "evidence tier" concept at all (ICP §22.B) and are never listed as missing evidence.
    expect(result.missingEvidence).not.toContain('maturity');
    expect(result.missingEvidence).not.toContain('decisionMaker');
    expect(result.missingEvidence).not.toContain('trigger');
    expect(result.missingEvidence).not.toContain('dtcFit');
  });

  it('checklist factors (maturity, decisionMaker, trigger, dtcFit) carry no evidenceTier field at all', () => {
    const input = blankInput();
    const result = scoreProspect(input);
    expect(result.factorBreakdown.maturity.evidenceTier).toBeUndefined();
    expect(result.factorBreakdown.decisionMaker.evidenceTier).toBeUndefined();
    expect(result.factorBreakdown.trigger.evidenceTier).toBeUndefined();
    expect(result.factorBreakdown.dtcFit.evidenceTier).toBeUndefined();
  });
});

describe('scoreProspect — revenue/spend disclosure status (independent of score)', () => {
  it('active ads alone (STRONG EVIDENCE on Paid Acquisition) must never be treated as proof of spend', () => {
    const input = blankInput();
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.paidAcquisition.googleAdsActive = true;
    const result = scoreProspect(input);
    expect(result.factorBreakdown.paidAcquisition.evidenceTier).toBe('STRONG_EVIDENCE');
    expect(result.spendDisclosureStatus).toBe('NOT_CONFIRMED'); // never CONFIRMED from activity alone
  });

  it('spend disclosure is CONFIRMED only when a primary source explicitly states the figure', () => {
    const input = blankInput();
    input.paidAcquisition.confirmedSpendStatement = true;
    const result = scoreProspect(input);
    expect(result.spendDisclosureStatus).toBe('CONFIRMED');
  });

  it('revenue/spend disclosure is UNKNOWN when no evidence of either kind exists', () => {
    const input = blankInput();
    const result = scoreProspect(input);
    expect(result.revenueDisclosureStatus).toBe('UNKNOWN');
    expect(result.spendDisclosureStatus).toBe('UNKNOWN');
  });

  it('an A-tier prospect can still have NOT_CONFIRMED disclosure on both revenue and spend (confirmed figures are not required to reach A)', () => {
    const input = blankInput();
    input.revenueFit.employeeCountBandMatch = true;
    input.revenueFit.shopifyPlusDetected = true;
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.paidAcquisition.googleAdsActive = true;
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    input.decisionMaker = { roleTier: 'founder_or_ceo', publicVisibility: true, correctProfileIdentified: true };
    input.trigger.verifiedTriggerCount = 2;
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;
    const result = scoreProspect(input);
    expect(result.tier).toBe('A');
    expect(result.revenueDisclosureStatus).toBe('NOT_CONFIRMED');
    expect(result.spendDisclosureStatus).toBe('NOT_CONFIRMED');
  });
});

describe('scoreProspect — trigger evidence points table', () => {
  it('0 verified triggers -> 0 points', () => {
    const input = blankInput();
    input.trigger.verifiedTriggerCount = 0;
    expect(scoreProspect(input).factorBreakdown.trigger.points).toBe(0);
  });

  it('exactly 1 verified trigger -> 10 points', () => {
    const input = blankInput();
    input.trigger.verifiedTriggerCount = 1;
    expect(scoreProspect(input).factorBreakdown.trigger.points).toBe(10);
  });

  it('2 or more verified triggers -> 15 points (capped, not scaled further)', () => {
    const input = blankInput();
    input.trigger.verifiedTriggerCount = 2;
    expect(scoreProspect(input).factorBreakdown.trigger.points).toBe(15);
    input.trigger.verifiedTriggerCount = 5;
    expect(scoreProspect(input).factorBreakdown.trigger.points).toBe(15);
  });
});

describe('scoreProspect — DTC/business model fit', () => {
  it('confirmed DTC with owned funnel -> 5 points', () => {
    const input = blankInput();
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;
    expect(scoreProspect(input).factorBreakdown.dtcFit.points).toBe(5);
  });

  it('anything else (that did not already trigger exclusion) -> 0 points', () => {
    const input = blankInput();
    input.dtcFit.confirmedDtcWithOwnedFunnel = false;
    expect(scoreProspect(input).factorBreakdown.dtcFit.points).toBe(0);
  });
});

describe('scoreProspect — weights sum to 100 (enforced end-to-end, not just as a constants check)', () => {
  it('a maximally-positive, non-excluded input caps at exactly 100', () => {
    const input = blankInput();
    input.revenueFit.confirmedRevenueStatement = true;
    input.paidAcquisition.confirmedSpendStatement = true;
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    input.decisionMaker = { roleTier: 'founder_or_ceo', publicVisibility: true, correctProfileIdentified: true };
    input.trigger.verifiedTriggerCount = 2;
    input.dtcFit.confirmedDtcWithOwnedFunnel = true;

    const result = scoreProspect(input);
    expect(result.score).toBe(100);
    expect(result.tier).toBe('A');
  });

  it('a maximally-negative, non-excluded input scores exactly 0', () => {
    const result = scoreProspect(blankInput());
    expect(result.score).toBe(0);
    expect(result.tier).toBe('Reject');
  });
});

describe('scoreProspect — exact score-band boundaries', () => {
  // Each case below is built by taking the 90-point A-tier golden example
  // and removing exactly the points needed to land on the boundary under
  // test, so every boundary is reached via a real, reproducible input
  // rather than by asserting tierForScore() in isolation (already covered
  // in scoring-boundaries.test.ts) — this proves the full scorer, not just
  // the lookup table, respects the boundary.
  function aTierBaseInput(): IcpScoringInput {
    const input = blankInput();
    input.revenueFit.employeeCountBandMatch = true;
    input.revenueFit.shopifyPlusDetected = true; // STRONG EVIDENCE -> 20
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.paidAcquisition.googleAdsActive = true; // STRONG EVIDENCE -> 20
    input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    }; // 15
    input.decisionMaker = { roleTier: 'founder_or_ceo', publicVisibility: true, correctProfileIdentified: true }; // 15
    input.trigger.verifiedTriggerCount = 2; // 15
    input.dtcFit.confirmedDtcWithOwnedFunnel = true; // 5
    return input; // total 90
  }

  it('89 vs 90: two inputs differing by exactly 1 point land on opposite sides of the A boundary', () => {
    const at90 = scoreProspect(aTierBaseInput());
    expect(at90.score).toBe(90);
    expect(at90.tier).toBe('A');

    // 25 (revenueFit CONFIRMED) + 20 (paidAcquisition STRONG) + 15 (maturity, all 4)
    // + 9 (decisionMaker: director-with-authority-signal(6) + no public visibility(0) + correct profile(3))
    // + 15 (trigger, 2+) + 5 (dtcFit) = 89.
    const at89Input = blankInput();
    at89Input.revenueFit.confirmedRevenueStatement = true;
    at89Input.paidAcquisition.metaAdActiveLast30Days = true;
    at89Input.paidAcquisition.googleAdsActive = true;
    at89Input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    at89Input.decisionMaker = {
      roleTier: 'director_with_authority_signal',
      publicVisibility: false,
      correctProfileIdentified: true,
    };
    at89Input.trigger.verifiedTriggerCount = 2;
    at89Input.dtcFit.confirmedDtcWithOwnedFunnel = true;

    const at89 = scoreProspect(at89Input);
    expect(at89.score).toBe(89);
    expect(at89.tier).toBe('B');
  });

  it('74 vs 75 boundary', () => {
    // 75: revenueFit LIKELY(10) + paidAcquisition STRONG(20) + maturity 15 + decisionMaker 15 + trigger 10 + dtcFit 5 = 75
    const at75Input = blankInput();
    at75Input.revenueFit.shopifyPlusDetected = true;
    at75Input.paidAcquisition.metaAdActiveLast30Days = true;
    at75Input.paidAcquisition.googleAdsActive = true;
    at75Input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    at75Input.decisionMaker = { roleTier: 'founder_or_ceo', publicVisibility: true, correctProfileIdentified: true };
    at75Input.trigger.verifiedTriggerCount = 1;
    at75Input.dtcFit.confirmedDtcWithOwnedFunnel = true;
    const at75 = scoreProspect(at75Input);
    expect(at75.score).toBe(75);
    expect(at75.tier).toBe('B');

    // 74: revenueFit STRONG(20) + paidAcquisition LIKELY(10) + maturity 15 + decisionMaker 9 (director(6)+noPublic(0)+profile(3)) + trigger 15 + dtcFit 5 = 74
    const at74Input = blankInput();
    at74Input.revenueFit.employeeCountBandMatch = true;
    at74Input.revenueFit.shopifyPlusDetected = true;
    at74Input.paidAcquisition.metaAdActiveLast30Days = true;
    at74Input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    at74Input.decisionMaker = {
      roleTier: 'director_with_authority_signal',
      publicVisibility: false,
      correctProfileIdentified: true,
    };
    at74Input.trigger.verifiedTriggerCount = 2;
    at74Input.dtcFit.confirmedDtcWithOwnedFunnel = true;
    const at74 = scoreProspect(at74Input);
    expect(at74.score).toBe(74);
    expect(at74.tier).toBe('C');
  });

  it('59 vs 60 boundary', () => {
    // 60: revenueFit STRONG(20) + paidAcquisition LIKELY(10) + maturity 15 + decisionMaker 10 (other(3)+public(4)+profile(3)) + trigger 0 + dtcFit 5 = 60
    const at60Input = blankInput();
    at60Input.revenueFit.employeeCountBandMatch = true;
    at60Input.revenueFit.shopifyPlusDetected = true;
    at60Input.paidAcquisition.metaAdActiveLast30Days = true;
    at60Input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    at60Input.decisionMaker = {
      roleTier: 'other_marketing_adjacent',
      publicVisibility: true,
      correctProfileIdentified: true,
    };
    at60Input.trigger.verifiedTriggerCount = 0;
    at60Input.dtcFit.confirmedDtcWithOwnedFunnel = true;
    const at60 = scoreProspect(at60Input);
    expect(at60.score).toBe(60);
    expect(at60.tier).toBe('C');

    // 59: same as above but decisionMaker drops public visibility (10 -> 9: director(6)+noPublic(0)+profile(3))
    const at59Input = blankInput();
    at59Input.revenueFit.employeeCountBandMatch = true;
    at59Input.revenueFit.shopifyPlusDetected = true;
    at59Input.paidAcquisition.metaAdActiveLast30Days = true;
    at59Input.maturity = {
      twoOrMoreConcurrentPaidChannels: true,
      twoOrMoreRetentionToolsDetected: true,
      analyticsTagDetected: true,
      twoOrMoreProductLines: true,
    };
    at59Input.decisionMaker = {
      roleTier: 'director_with_authority_signal',
      publicVisibility: false,
      correctProfileIdentified: true,
    };
    at59Input.trigger.verifiedTriggerCount = 0;
    at59Input.dtcFit.confirmedDtcWithOwnedFunnel = true;
    const at59 = scoreProspect(at59Input);
    expect(at59.score).toBe(59);
    expect(at59.tier).toBe('Reject');
  });
});

describe('scoreProspect — determinism', () => {
  it('the same input always produces the exact same output, called repeatedly', () => {
    const input = blankInput();
    input.revenueFit.employeeCountBandMatch = true;
    input.paidAcquisition.metaAdActiveLast30Days = true;
    input.trigger.verifiedTriggerCount = 1;

    const results = Array.from({ length: 20 }, () => scoreProspect(input));
    const first = JSON.stringify(results[0]);
    for (const r of results) {
      expect(JSON.stringify(r)).toBe(first);
    }
  });

  it('every returned score result includes the scoring engine version, for later score-logic-change auditability', () => {
    const result = scoreProspect(blankInput());
    expect(typeof result.scoringEngineVersion).toBe('string');
    expect(result.scoringEngineVersion.length).toBeGreaterThan(0);
  });

  it('the score result is fully explainable: every factor lists points, maxPoints, and (where applicable) evidenceTier', () => {
    const result = scoreProspect(blankInput());
    for (const entry of Object.values(result.factorBreakdown)) {
      expect(typeof entry.points).toBe('number');
      expect(typeof entry.maxPoints).toBe('number');
    }
    expect(typeof result.recommendedAction).toBe('string');
    expect(result.recommendedAction.length).toBeGreaterThan(0);
  });
});
