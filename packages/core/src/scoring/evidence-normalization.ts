import type {
  DecisionMakerRoleTier,
  DtcFitEvidence,
  ExclusionEvidence,
  IcpScoringInput,
  MaturityEvidence,
} from './scorer.js';

/**
 * Maps already-gathered evidence facts (shaped like `evidence` table rows,
 * DATABASE.md §1) into the structured `IcpScoringInput` the pure scorer
 * (`scorer.ts`) consumes. This is still zero-I/O — it takes an array of
 * facts already fetched by the caller, it does not query anything itself —
 * so it stays consistent with BUILD_PLAN.md Stage 3's "pure function, no
 * I/O" requirement for the scoring pipeline as a whole.
 *
 * Signal-category key strings below follow DATABASE.md's own worked
 * examples for `evidence.signal_category` ("employee_count_band",
 * "meta_ad_active_30d", "shopify_plus_detected") and extend that naming
 * convention consistently for every other fixed category the ICP document
 * defines. These are internal key strings only, chosen because
 * DATABASE.md's schema explicitly leaves category-string enforcement to the
 * application layer — they do not change any weight, multiplier, or rule.
 */

/** ICP §22.A / §22.B fixed signal-category keys, grouped by the evidence_type they'd be stored under (DATABASE.md `evidence.evidence_type`). */
export const SIGNAL_CATEGORIES = {
  revenue_signal: {
    employeeCountBand: 'employee_count_band',
    shopifyPlusDetected: 'shopify_plus_detected',
    warehouseFulfillmentSignal: 'warehouse_fulfillment_signal',
    /**
     * Signal 4 (ICP §22.A). Deliberately its own fact category rather than
     * being derived from the paid-acquisition facts below — see
     * `RevenueFitEvidence`'s doc comment in scorer.ts for the documented
     * ICP §22.A/§22.F contradiction this avoids baking in automatically.
     */
    twoOrMorePaidAcquisitionCategoriesPresent: 'two_or_more_paid_acquisition_categories_present',
    /** Distinct from the counted categories above — this one short-circuits straight to CONFIRMED tier and must only be set when a primary source states the actual figure (ICP §22.A). */
    confirmedRevenueStatement: 'confirmed_revenue_statement',
  },
  paid_acquisition_signal: {
    metaAdActive30d: 'meta_ad_active_30d',
    googleAdsActive: 'google_ads_active',
    paidMediaJobPosting90d: 'paid_media_job_posting_90d',
    namedAgencyClient: 'named_agency_client',
    /** Must only be set when a primary source explicitly states a spend figure >= $15k/month. Active ad presence alone must never set this. */
    confirmedSpendStatement: 'confirmed_spend_statement',
  },
  maturity_signal: {
    twoOrMoreConcurrentPaidChannels: 'two_or_more_paid_channels',
    twoOrMoreRetentionTools: 'two_or_more_retention_tools',
    analyticsTagDetected: 'analytics_tag_detected',
    twoOrMoreProductLines: 'two_or_more_product_lines',
  },
  decision_maker_signal: {
    roleFounderOrCeo: 'role_founder_or_ceo',
    roleDirectorWithAuthoritySignal: 'role_director_with_authority_signal',
    roleOtherMarketingAdjacent: 'role_other_marketing_adjacent',
    roleExecutionOnly: 'role_execution_only',
    publicVisibility: 'public_visibility',
    correctProfileIdentified: 'correct_profile_identified',
  },
  dtc_signal: {
    confirmedDtcWithOwnedFunnel: 'confirmed_dtc_with_owned_funnel',
  },
} as const;

/** ICP §16's six valid trigger types. "Ad volume increase" is deliberately not one of them (§22.B: not a valid trigger without two dated observations the ICP explicitly excludes from this fixed list anyway). */
export const VALID_TRIGGER_TYPES = [
  'new_product_launch',
  'store_brand_expansion',
  'active_growth_hiring',
  'funding_growth_announcement',
  'funnel_offer_change',
  'new_paid_channel_appearing',
] as const;
export type ValidTriggerType = (typeof VALID_TRIGGER_TYPES)[number];

/**
 * A single trigger claim. Represented separately from the flat fact list
 * below (rather than as another presence-only category) because triggers
 * carry their own verification requirements the ICP document is explicit
 * about: a source URL is mandatory, and `new_paid_channel_appearing`
 * specifically requires a prior dated observation proving the channel's
 * absence — "ad volume increase" is excluded from the valid-type list
 * entirely for exactly this reason (current activity alone is never enough).
 */
export interface TriggerFact {
  triggerType: ValidTriggerType;
  /** ICP §22.B: "sourced with a specific URL/reference." A trigger with no source never counts, regardless of type. */
  sourceUrl: string;
  /**
   * Required `true` for `new_paid_channel_appearing` only — represents "the
   * Skill has a prior dated observation confirming its prior absence."
   * Ignored for every other trigger type, which the ICP document does not
   * impose this additional requirement on.
   */
  priorDatedAbsenceConfirmed?: boolean;
}

/** A single evidence fact — presence of a matching row is the signal. Mirrors `evidence.evidence_type` / `evidence.signal_category` (DATABASE.md §1). */
export interface EvidenceFact {
  evidenceType: keyof typeof SIGNAL_CATEGORIES;
  signalCategory: string;
}

/**
 * Exclusion determinations that cannot be safely derived from the six
 * scored factors below. `noPaidAcquisitionActivityDetected` is the one
 * exception — deliberately NOT accepted here, because the ICP document
 * defines it as identical to "0 Paid Acquisition Activity/Intensity Fit
 * categories present," which this function already computes from `facts`;
 * accepting it as a separate flag here would let a caller contradict that
 * derivation. The other three exclusions (§15) are standalone factual
 * determinations with no accumulable evidence-category model anywhere in
 * DATABASE.md or the ICP document, so they must be supplied directly.
 */
export interface ExclusionDeterminations {
  notDtcEcommerce: boolean;
  companyAppearsDefunct: boolean;
  onlyContactHasNoBudgetAuthority: boolean;
}

export interface NormalizeEvidenceInput {
  facts: EvidenceFact[];
  triggers: TriggerFact[];
  exclusions: ExclusionDeterminations;
}

function hasFact(facts: EvidenceFact[], evidenceType: EvidenceFact['evidenceType'], signalCategory: string): boolean {
  return facts.some((f) => f.evidenceType === evidenceType && f.signalCategory === signalCategory);
}

/**
 * ICP §22.B: a trigger only counts as verified if it is sourced, and (for
 * `new_paid_channel_appearing` specifically) backed by a prior dated
 * absence observation. Independent means distinct trigger types — two
 * facts of the same type are not counted as two separate triggers.
 */
export function countVerifiedTriggers(triggers: TriggerFact[]): number {
  const verifiedTypes = new Set<ValidTriggerType>();
  for (const t of triggers) {
    if (!t.sourceUrl || t.sourceUrl.trim().length === 0) continue;
    if (t.triggerType === 'new_paid_channel_appearing' && !t.priorDatedAbsenceConfirmed) continue;
    verifiedTypes.add(t.triggerType);
  }
  return verifiedTypes.size;
}

function decisionMakerRoleTier(facts: EvidenceFact[]): DecisionMakerRoleTier {
  const c = SIGNAL_CATEGORIES.decision_maker_signal;
  // Priority order matches the point ordering in ICP §22.B — if more than
  // one role fact is somehow present (shouldn't happen for one person),
  // the highest-authority one wins rather than silently picking randomly.
  if (hasFact(facts, 'decision_maker_signal', c.roleFounderOrCeo)) return 'founder_or_ceo';
  if (hasFact(facts, 'decision_maker_signal', c.roleDirectorWithAuthoritySignal)) return 'director_with_authority_signal';
  if (hasFact(facts, 'decision_maker_signal', c.roleOtherMarketingAdjacent)) return 'other_marketing_adjacent';
  return 'execution_only';
}

function normalizeMaturity(facts: EvidenceFact[]): MaturityEvidence {
  const c = SIGNAL_CATEGORIES.maturity_signal;
  return {
    twoOrMoreConcurrentPaidChannels: hasFact(facts, 'maturity_signal', c.twoOrMoreConcurrentPaidChannels),
    twoOrMoreRetentionToolsDetected: hasFact(facts, 'maturity_signal', c.twoOrMoreRetentionTools),
    analyticsTagDetected: hasFact(facts, 'maturity_signal', c.analyticsTagDetected),
    twoOrMoreProductLines: hasFact(facts, 'maturity_signal', c.twoOrMoreProductLines),
  };
}

function normalizeDtcFit(facts: EvidenceFact[]): DtcFitEvidence {
  return {
    confirmedDtcWithOwnedFunnel: hasFact(
      facts,
      'dtc_signal',
      SIGNAL_CATEGORIES.dtc_signal.confirmedDtcWithOwnedFunnel
    ),
  };
}

export function normalizeEvidenceForScoring(input: NormalizeEvidenceInput): IcpScoringInput {
  const { facts, triggers, exclusions } = input;
  const revenue = SIGNAL_CATEGORIES.revenue_signal;
  const paid = SIGNAL_CATEGORIES.paid_acquisition_signal;
  const dm = SIGNAL_CATEGORIES.decision_maker_signal;

  const paidAcquisitionHasAnyCategory =
    hasFact(facts, 'paid_acquisition_signal', paid.metaAdActive30d) ||
    hasFact(facts, 'paid_acquisition_signal', paid.googleAdsActive) ||
    hasFact(facts, 'paid_acquisition_signal', paid.paidMediaJobPosting90d) ||
    hasFact(facts, 'paid_acquisition_signal', paid.namedAgencyClient);
  const confirmedSpendStatement = hasFact(facts, 'paid_acquisition_signal', paid.confirmedSpendStatement);

  const resolvedExclusions: ExclusionEvidence = {
    notDtcEcommerce: exclusions.notDtcEcommerce,
    // ICP §15: "No detectable paid acquisition activity of any kind" is
    // definitionally the same fact as "0 Paid Acquisition Activity/
    // Intensity Fit categories present" (ICP §22.A) — derived here rather
    // than accepted as a separate input so the two can never disagree.
    noPaidAcquisitionActivityDetected: !paidAcquisitionHasAnyCategory && !confirmedSpendStatement,
    companyAppearsDefunct: exclusions.companyAppearsDefunct,
    onlyContactHasNoBudgetAuthority: exclusions.onlyContactHasNoBudgetAuthority,
  };

  return {
    exclusions: resolvedExclusions,
    revenueFit: {
      employeeCountBandMatch: hasFact(facts, 'revenue_signal', revenue.employeeCountBand),
      shopifyPlusDetected: hasFact(facts, 'revenue_signal', revenue.shopifyPlusDetected),
      warehouseFulfillmentSignal: hasFact(facts, 'revenue_signal', revenue.warehouseFulfillmentSignal),
      twoOrMorePaidAcquisitionCategoriesPresent: hasFact(
        facts,
        'revenue_signal',
        revenue.twoOrMorePaidAcquisitionCategoriesPresent
      ),
      confirmedRevenueStatement: hasFact(facts, 'revenue_signal', revenue.confirmedRevenueStatement),
    },
    paidAcquisition: {
      metaAdActiveLast30Days: hasFact(facts, 'paid_acquisition_signal', paid.metaAdActive30d),
      googleAdsActive: hasFact(facts, 'paid_acquisition_signal', paid.googleAdsActive),
      paidMediaJobPostingLast90Days: hasFact(facts, 'paid_acquisition_signal', paid.paidMediaJobPosting90d),
      namedAgencyClient: hasFact(facts, 'paid_acquisition_signal', paid.namedAgencyClient),
      confirmedSpendStatement,
    },
    maturity: normalizeMaturity(facts),
    decisionMaker: {
      roleTier: decisionMakerRoleTier(facts),
      publicVisibility: hasFact(facts, 'decision_maker_signal', dm.publicVisibility),
      correctProfileIdentified: hasFact(facts, 'decision_maker_signal', dm.correctProfileIdentified),
    },
    trigger: { verifiedTriggerCount: countVerifiedTriggers(triggers) },
    dtcFit: normalizeDtcFit(facts),
  };
}
