import { SIGNAL_CATEGORIES, VALID_TRIGGER_TYPES, type ValidTriggerType } from '@metrivio/core';

/**
 * Personalization candidate generation (Stage 6A, Sections D/E).
 *
 * Hard rule this entire module exists to enforce: personalization may only
 * ever restate a fact that is *already sitting in the database* as an
 * `evidence`/`pain_signals` row or a `technology_detections` row — it never
 * infers, estimates, or synthesizes anything new. This is enforced
 * structurally, not just by convention: every function below takes
 * already-persisted rows as input (no I/O of its own) and only reacts to a
 * small, explicit allowlist of (evidenceType, signalCategory) pairs already
 * defined by Stage 3 (`SIGNAL_CATEGORIES`) — an evidence row of an
 * unrecognized type/category, or a technology detection outside the
 * allowlisted set, produces no candidate at all rather than a guessed one.
 */

export type PersonalizationHookType = 'role_company' | 'website_technology' | 'pain_intent' | 'business_trigger' | 'acquisition_signal';

/** FACT = a CONFIRMED-tier, directly-observed row. INFERENCE = a lower-tier or single-source-derived observation. UNKNOWN = evidence exists but is too weak to reference at all (never produced as a candidate — listed here only so the type is honest about what the confidence axis means). */
export type PersonalizationConfidence = 'FACT' | 'INFERENCE' | 'UNKNOWN';

export interface PersonalizationCandidate {
  hookType: PersonalizationHookType;
  /** Plain-language description of the observation, built only from the evidence row's own stored category/rawValue — never phrased as a dollar figure, ROAS/CAC number, or headcount claim beyond what the row itself states. */
  observation: string;
  sourceUrl: string | null;
  /** The exact `evidence`/`pain_signals` row id this candidate was built from — always traceable back to one row. */
  evidenceId: string;
  confidence: PersonalizationConfidence;
  /** The row's own stored evidence tier, carried through for audit purposes only (mirrors the Stage 3 rule that a stored tier is provenance metadata, not something this module re-derives). `null` for `pain_signals` rows, which carry no tier column. */
  evidenceTier: 'CONFIRMED' | 'STRONG_EVIDENCE' | 'LIKELY' | 'UNKNOWN' | null;
  whyRelevant: string;
  /** True only when confidence is FACT — the one condition under which an outreach draft may state this observation as a plain fact rather than an inference/observation. */
  safeToStateAsFact: boolean;
}

export interface EvidenceRowInput {
  id: string;
  evidenceType: string;
  signalCategory: string;
  evidenceTier: 'CONFIRMED' | 'STRONG_EVIDENCE' | 'LIKELY' | 'UNKNOWN';
  rawValue: string | null;
  sourceUrl: string | null;
}

export interface PainSignalRowInput {
  id: string;
  topic: string;
  signalText: string;
  sourceUrl: string | null;
}

export interface TechnologyDetectionInput {
  technologyName: string;
  status: 'DETECTED' | 'NOT_DETECTED';
  sourceUrl: string | null;
}

function confidenceFromTier(tier: 'CONFIRMED' | 'STRONG_EVIDENCE' | 'LIKELY' | 'UNKNOWN'): PersonalizationConfidence {
  return tier === 'CONFIRMED' ? 'FACT' : 'INFERENCE';
}

// ---------------------------------------------------------------------------
// 1. Verified role/company observation
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<string, string> = {
  [SIGNAL_CATEGORIES.decision_maker_signal.roleFounderOrCeo]: 'Founder/CEO',
  [SIGNAL_CATEGORIES.decision_maker_signal.roleDirectorWithAuthoritySignal]: 'a Director-level marketing/growth role',
  [SIGNAL_CATEGORIES.decision_maker_signal.roleOtherMarketingAdjacent]: 'a marketing-adjacent role',
};
// Priority order matches ICP §22.B's own authority ordering — if more than
// one role fact somehow exists for the same person, the highest-authority
// one is surfaced, never a contradictory pair in the same draft.
const ROLE_PRIORITY: readonly string[] = [
  SIGNAL_CATEGORIES.decision_maker_signal.roleFounderOrCeo,
  SIGNAL_CATEGORIES.decision_maker_signal.roleDirectorWithAuthoritySignal,
  SIGNAL_CATEGORIES.decision_maker_signal.roleOtherMarketingAdjacent,
];

export function buildRoleCompanyCandidates(evidenceRows: EvidenceRowInput[], companyName: string | null): PersonalizationCandidate[] {
  const roleRows = evidenceRows.filter((r) => r.evidenceType === 'decision_maker_signal' && ROLE_PRIORITY.includes(r.signalCategory));
  let chosen: EvidenceRowInput | undefined;
  for (const category of ROLE_PRIORITY) {
    chosen = roleRows.find((r) => r.signalCategory === category);
    if (chosen) break;
  }
  if (!chosen) return [];

  const roleLabel = ROLE_LABELS[chosen.signalCategory] ?? 'a marketing-adjacent role';
  const confidence = confidenceFromTier(chosen.evidenceTier);
  return [
    {
      hookType: 'role_company',
      observation: companyName ? `${roleLabel} at ${companyName}` : roleLabel,
      sourceUrl: chosen.sourceUrl,
      evidenceId: chosen.id,
      confidence,
      evidenceTier: chosen.evidenceTier,
      whyRelevant: 'establishes that this person has the authority to act on an outreach conversation',
      safeToStateAsFact: confidence === 'FACT',
    },
  ];
}

// ---------------------------------------------------------------------------
// 2. Verified website/technology observation
// ---------------------------------------------------------------------------

/**
 * Deliberately technology-presence-only. Never derives a business-model
 * claim ("this means they're DTC") or an acquisition-activity claim ("this
 * means they run paid ads") from a detected technology — those are
 * different fixed evidence categories with their own independent
 * verification requirements (ICP §22.A/§15), and conflating them is
 * exactly the failure mode this stage's adversarial tests target
 * ("Shopify must not automatically become DTC," "technology must not
 * become paid acquisition").
 */
export function buildWebsiteTechnologyCandidates(detections: TechnologyDetectionInput[]): PersonalizationCandidate[] {
  const detected = detections.filter((d) => d.status === 'DETECTED');
  if (detected.length === 0) return [];
  const names = detected.map((d) => d.technologyName);
  return [
    {
      hookType: 'website_technology',
      observation: `their site runs on ${names.join(', ')}`,
      sourceUrl: detected[0]?.sourceUrl ?? null,
      evidenceId: 'technology_detections', // no single row id is threaded through TechAnalyzerResult today — see RISK_REGISTER.md Stage 6 findings.
      confidence: 'FACT', // a technology fingerprint match is a direct, binary observation, not an inference.
      evidenceTier: 'CONFIRMED',
      whyRelevant: 'shows familiarity with their actual stack rather than a generic guess',
      safeToStateAsFact: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// 3. Verified pain/intent observation
// ---------------------------------------------------------------------------

/**
 * `pain_signals` rows carry no evidence-tier column (schema.ts) — a single
 * X post is never presented as a confirmed pain, only as an observed
 * signal/quote, so confidence is always INFERENCE and `safeToStateAsFact`
 * is always false here, regardless of how specific the quoted text is.
 */
export function buildPainIntentCandidates(painSignals: PainSignalRowInput[]): PersonalizationCandidate[] {
  return painSignals.map((p) => ({
    hookType: 'pain_intent' as const,
    observation: `mentioned ${p.topic}: "${p.signalText}"`,
    sourceUrl: p.sourceUrl,
    evidenceId: p.id,
    confidence: 'INFERENCE' as const,
    evidenceTier: null,
    whyRelevant: `a self-reported signal about ${p.topic}, directly relevant to Metrivio's offer`,
    safeToStateAsFact: false,
  }));
}

// ---------------------------------------------------------------------------
// 4. Verified recent business trigger
// ---------------------------------------------------------------------------

/** Reuses Stage 3's own `VALID_TRIGGER_TYPES` list and its "must be sourced" rule (ICP §22.B) — never a separate, looser trigger vocabulary. */
export function buildBusinessTriggerCandidates(evidenceRows: EvidenceRowInput[]): PersonalizationCandidate[] {
  return evidenceRows
    .filter((r) => r.evidenceType === 'trigger_signal' && (VALID_TRIGGER_TYPES as readonly string[]).includes(r.signalCategory) && !!r.sourceUrl)
    .map((r) => {
      const confidence = confidenceFromTier(r.evidenceTier);
      return {
        hookType: 'business_trigger' as const,
        observation: `${(r.signalCategory as ValidTriggerType).replace(/_/g, ' ')}`,
        sourceUrl: r.sourceUrl,
        evidenceId: r.id,
        confidence,
        evidenceTier: r.evidenceTier,
        whyRelevant: 'a recent, sourced business event — the strongest possible "why now" for outreach timing',
        safeToStateAsFact: confidence === 'FACT',
      };
    });
}

// ---------------------------------------------------------------------------
// 5. Verified acquisition signal
// ---------------------------------------------------------------------------

const ACQUISITION_LABELS: Record<string, string> = {
  [SIGNAL_CATEGORIES.paid_acquisition_signal.metaAdActive30d]: 'running active Meta ads',
  [SIGNAL_CATEGORIES.paid_acquisition_signal.googleAdsActive]: 'running active Google ads',
  [SIGNAL_CATEGORIES.paid_acquisition_signal.paidMediaJobPosting90d]: 'hiring for a paid-media role',
  [SIGNAL_CATEGORIES.paid_acquisition_signal.namedAgencyClient]: 'working with a paid-media agency',
  // Deliberately still a non-numeric label — see the doc comment below.
  // The primary-source figure itself lives on the evidence row
  // (`rawValue`) for a human reviewer to see, never auto-inserted here.
  [SIGNAL_CATEGORIES.paid_acquisition_signal.confirmedSpendStatement]: 'has disclosed a specific paid-spend figure in a primary source',
};

/**
 * ICP §22.A's own hard rule applies unchanged here: `confirmedSpendStatement`
 * is the only category that could ever justify stating a number, and even
 * then this module never interpolates the raw dollar figure into a
 * template (see `../drafts/message-templates.ts`) — it only marks the
 * candidate `safeToStateAsFact` for a human reviewer to see.
 */
export function buildAcquisitionSignalCandidates(evidenceRows: EvidenceRowInput[]): PersonalizationCandidate[] {
  return evidenceRows
    .filter((r) => r.evidenceType === 'paid_acquisition_signal' && r.signalCategory in ACQUISITION_LABELS)
    .map((r) => {
      const confidence = confidenceFromTier(r.evidenceTier);
      return {
        hookType: 'acquisition_signal' as const,
        observation: ACQUISITION_LABELS[r.signalCategory] ?? 'evidence of paid acquisition activity',
        sourceUrl: r.sourceUrl,
        evidenceId: r.id,
        confidence,
        evidenceTier: r.evidenceTier,
        whyRelevant: 'directly relevant to Metrivio\'s paid-acquisition/attribution offer',
        safeToStateAsFact: confidence === 'FACT',
      };
    });
}

export interface BuildPersonalizationCandidatesInput {
  evidenceRows: EvidenceRowInput[];
  painSignals: PainSignalRowInput[];
  technologyDetections: TechnologyDetectionInput[];
  companyName: string | null;
}

/** Deterministic: same inputs always produce the same candidate array, in the same order (instruction L). */
export function buildPersonalizationCandidates(input: BuildPersonalizationCandidatesInput): PersonalizationCandidate[] {
  return [
    ...buildBusinessTriggerCandidates(input.evidenceRows),
    ...buildAcquisitionSignalCandidates(input.evidenceRows),
    ...buildRoleCompanyCandidates(input.evidenceRows, input.companyName),
    ...buildWebsiteTechnologyCandidates(input.technologyDetections),
    ...buildPainIntentCandidates(input.painSignals),
  ];
}
