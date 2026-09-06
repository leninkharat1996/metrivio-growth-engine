import { and, desc, eq } from 'drizzle-orm';
import { schema, type MetrivioDb, type createLogger } from '@metrivio/core';
import { OutreachDraftService, type GenerateDraftResult } from './draft-store.js';
import type { EvidenceRowInput, PainSignalRowInput, TechnologyDetectionInput } from '../personalization/personalization-candidates.js';

/**
 * The I/O layer around `OutreachDraftService.generateDraft()` — gathers
 * `evidence`/`pain_signals`/`technology_detections` rows for a prospect
 * (read-only, reusing the domain's most recent *successful* technology
 * scan exactly like `EvidenceAssemblyService`/`WebsiteEvidenceService`
 * already do — a failed scan contributes zero technology facts here
 * either) and hands them to the pure candidate builder via
 * `OutreachDraftService`.
 */
export class DraftGenerationService {
  private readonly draftService: OutreachDraftService;

  constructor(
    private readonly db: MetrivioDb,
    logger?: ReturnType<typeof createLogger>
  ) {
    this.draftService = new OutreachDraftService(db, logger);
  }

  async generateDraftForProspect(prospectId: string): Promise<GenerateDraftResult> {
    const { prospect, evidenceRows, painSignals, technologyDetections } = await this.gatherPersonalizationInputs(prospectId);

    return this.draftService.generateDraft({
      prospectId,
      displayName: prospect.displayName,
      companyName: prospect.companyName,
      evidenceRows,
      painSignals,
      technologyDetections,
    });
  }

  /**
   * The prospect lookup plus `evidence`/`pain_signals`/`technology_detections`
   * gathering shared by both an original draft (`generateDraftForProspect`
   * above) and a Stage 6D follow-up draft (`FollowUpDraftService`) — kept
   * as one method so a follow-up never runs a second, drifting copy of
   * these exact queries (Stage 6D Section D: "reuse Stage 6A
   * personalization infrastructure").
   */
  async gatherPersonalizationInputs(prospectId: string): Promise<{
    prospect: typeof schema.prospects.$inferSelect;
    evidenceRows: EvidenceRowInput[];
    painSignals: PainSignalRowInput[];
    technologyDetections: TechnologyDetectionInput[];
  }> {
    const prospectRows = await this.db.select().from(schema.prospects).where(eq(schema.prospects.id, prospectId)).limit(1);
    const prospect = prospectRows[0];
    if (!prospect) {
      throw new Error(`Cannot generate outreach draft: no prospect found with id ${prospectId}`);
    }

    const [evidenceRows, painSignalRows, technologyDetections] = await Promise.all([
      this.db.select().from(schema.evidence).where(eq(schema.evidence.prospectId, prospectId)),
      this.db.select().from(schema.painSignals).where(eq(schema.painSignals.prospectId, prospectId)),
      prospect.companyDomain ? this.getLatestTechnologyDetections(prospect.companyDomain) : Promise.resolve([]),
    ]);

    const evidenceInput: EvidenceRowInput[] = evidenceRows.map((r) => ({
      id: r.id,
      evidenceType: r.evidenceType,
      signalCategory: r.signalCategory,
      evidenceTier: r.evidenceTier,
      rawValue: r.rawValue,
      sourceUrl: r.sourceUrl,
    }));
    const painSignalInput: PainSignalRowInput[] = painSignalRows.map((r) => ({ id: r.id, topic: r.topic, signalText: r.signalText, sourceUrl: r.sourceUrl }));

    return { prospect, evidenceRows: evidenceInput, painSignals: painSignalInput, technologyDetections };
  }

  private async getLatestTechnologyDetections(companyDomain: string): Promise<TechnologyDetectionInput[]> {
    const scans = await this.db
      .select()
      .from(schema.technologyScans)
      .where(and(eq(schema.technologyScans.companyDomain, companyDomain), eq(schema.technologyScans.scanStatus, 'OK')))
      .orderBy(desc(schema.technologyScans.scannedAt))
      .limit(1);
    const scan = scans[0];
    if (!scan) return [];

    const detections = await this.db.select().from(schema.technologyDetections).where(eq(schema.technologyDetections.scanId, scan.id));
    return detections.map((d) => ({ technologyName: d.technologyName, status: d.status, sourceUrl: `https://${companyDomain}` }));
  }

  /** Exposed for direct use once a draft already exists (submit/approve/reject) — avoids callers needing to construct their own OutreachDraftService instance. */
  get drafts(): OutreachDraftService {
    return this.draftService;
  }
}
