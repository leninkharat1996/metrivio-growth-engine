import { and, desc, eq } from 'drizzle-orm';
import {
  schema,
  SIGNAL_CATEGORIES,
  VALID_TRIGGER_TYPES,
  type MetrivioDb,
  type EvidenceFact,
  type TriggerFact,
  type ValidTriggerType,
} from '@metrivio/core';

/**
 * Evidence Assembly readers — BUILD_PLAN.md Stage 4C. Converts already-
 * persisted rows (Stage 4B's `evidence` rows, Stage 2's `technology_scans`/
 * `technology_detections`) into Stage 3's exact `EvidenceFact[]`/
 * `TriggerFact[]` input shapes. Read-only: no scan is triggered here (that
 * is `EvidenceAssemblyService`'s job, via the existing
 * `TechnologyEnrichmentService`), and nothing here calls `scoreProspect`.
 */

const SCORED_EVIDENCE_TYPES = new Set(Object.keys(SIGNAL_CATEGORIES));

function isScoredEvidenceType(t: string): t is keyof typeof SIGNAL_CATEGORIES {
  return SCORED_EVIDENCE_TYPES.has(t);
}

/**
 * Reads a prospect's `evidence` rows and maps them to `EvidenceFact[]`.
 *
 * Deliberately drops each row's own `evidence_tier` column — Stage 3's
 * scorer derives Revenue-Fit/Paid-Acquisition tiers itself by counting
 * fixed signal categories (ICP §22.A's corroboration rule); a row's stored
 * tier is provenance/auditability metadata only and must never become a
 * second, competing tier-derivation path. `company_identification` and
 * `trigger_signal` rows are excluded here — the former is not one of Stage
 * 3's five scored evidence types at all (it feeds `prospects.company_name`/
 * `company_domain` directly, already handled at discovery time); the latter
 * is handled by `readTriggerFacts` below, since it needs different
 * verification logic (a source URL requirement), not simple presence.
 */
export async function readXEvidenceFacts(db: MetrivioDb, prospectId: string): Promise<EvidenceFact[]> {
  const rows = await db.select().from(schema.evidence).where(eq(schema.evidence.prospectId, prospectId));
  const facts: EvidenceFact[] = [];
  for (const row of rows) {
    if (!isScoredEvidenceType(row.evidenceType)) continue;
    facts.push({ evidenceType: row.evidenceType, signalCategory: row.signalCategory });
  }
  return facts;
}

/**
 * Reads any `trigger_signal` evidence rows and converts qualifying ones into
 * `TriggerFact[]`. No current pipeline stage (Stage 4B discovery included)
 * actually writes `trigger_signal` rows — this reader exists so the
 * assembly pipeline is correct and forward-compatible if a future stage
 * ever does, without this stage inventing trigger evidence itself.
 *
 * A row only converts to a `TriggerFact` when:
 *  - its `signal_category` is one of the six ICP §16/§22.B valid trigger
 *    types (an unrecognized category is never passed through), and
 *  - it has a non-empty `source_url` (ICP §22.B: "sourced with a specific
 *    URL/reference" is mandatory for every trigger type).
 *
 * `new_paid_channel_appearing` specifically additionally requires "a prior
 * dated observation confirming its prior absence" (ICP §22.B) — a fact that
 * cannot be represented by a single evidence row's columns. No current
 * schema/pipeline pairs two dated observations into that verification, so
 * this reader deliberately never converts a `new_paid_channel_appearing`
 * row into a verified `TriggerFact`, rather than fabricating the missing
 * half of the requirement.
 */
export async function readTriggerFacts(db: MetrivioDb, prospectId: string): Promise<TriggerFact[]> {
  const rows = await db
    .select()
    .from(schema.evidence)
    .where(and(eq(schema.evidence.prospectId, prospectId), eq(schema.evidence.evidenceType, 'trigger_signal')));

  const facts: TriggerFact[] = [];
  for (const row of rows) {
    const category = row.signalCategory as ValidTriggerType;
    if (!(VALID_TRIGGER_TYPES as readonly string[]).includes(category)) continue;
    if (!row.sourceUrl) continue;
    if (category === 'new_paid_channel_appearing') continue; // see doc comment above
    facts.push({ triggerType: category, sourceUrl: row.sourceUrl });
  }
  return facts;
}

/** Klaviyo/Recharge/Yotpo/Gorgias — ICP §22.B Maturity checklist item 2. */
const RETENTION_TOOLS = ['Klaviyo', 'Recharge', 'Yotpo', 'Gorgias'];
/** GA4/GTM/Meta Pixel — ICP §22.B Maturity checklist item 3. */
const ANALYTICS_TAGS = ['GA4', 'GTM', 'Meta Pixel'];

/**
 * Reads the prospect's most recent successful (`scanStatus === 'OK'`)
 * technology scan (Stage 2 — never triggers a new scan itself; that is
 * `EvidenceAssemblyService`'s job via the existing
 * `TechnologyEnrichmentService`) and maps DETECTED technologies to Stage
 * 3's fixed maturity signal categories only.
 *
 * Deliberately does NOT map anything to `revenue_signal.shopifyPlusDetected`
 * even when "Shopify" is detected: `packages/adapters/src/
 * open-tech-analyzer.adapter.ts`'s own `WATCHED_TECHNOLOGIES` list does not
 * include "Shopify Plus" as a distinct, independently-confirmed fingerprint
 * (RESEARCH.md §2A.7) — only plain "Shopify" is ever actually detected.
 * Treating a plain-Shopify detection as "Shopify Plus detected" would be
 * exactly the kind of unverified claim this project forbids throughout.
 * This is a real, current gap — see the Stage 4C completion report.
 *
 * Also deliberately never maps any technology detection to
 * `paid_acquisition_signal` — Meta Pixel/GA4/GTM presence is maturity
 * evidence only (ICP §22.B), never evidence of active ad spend (ICP §22.A
 * explicitly requires Meta Ad Library / Google Ads *activity*, which a
 * tracking-pixel detection does not establish).
 */
export async function readTechnologyEvidenceFacts(db: MetrivioDb, companyDomain: string): Promise<EvidenceFact[]> {
  const scans = await db
    .select()
    .from(schema.technologyScans)
    .where(and(eq(schema.technologyScans.companyDomain, companyDomain), eq(schema.technologyScans.scanStatus, 'OK')))
    .orderBy(desc(schema.technologyScans.scannedAt))
    .limit(1);
  const scan = scans[0];
  if (!scan) return [];

  const detections = await db
    .select()
    .from(schema.technologyDetections)
    .where(eq(schema.technologyDetections.scanId, scan.id));
  const detectedNames = new Set(detections.filter((d) => d.status === 'DETECTED').map((d) => d.technologyName));

  const facts: EvidenceFact[] = [];
  const retentionCount = RETENTION_TOOLS.filter((name) => detectedNames.has(name)).length;
  if (retentionCount >= 2) {
    facts.push({
      evidenceType: 'maturity_signal',
      signalCategory: SIGNAL_CATEGORIES.maturity_signal.twoOrMoreRetentionTools,
    });
  }
  if (ANALYTICS_TAGS.some((name) => detectedNames.has(name))) {
    facts.push({
      evidenceType: 'maturity_signal',
      signalCategory: SIGNAL_CATEGORIES.maturity_signal.analyticsTagDetected,
    });
  }
  return facts;
}
