import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  JobRunner,
  schema,
  normalizeEvidenceForScoring,
  scoreProspect,
  type MetrivioDb,
  type IcpScoreResult,
  type ExclusionEvidence,
  type TechAnalyzeOptions,
  type createLogger,
} from '@metrivio/core';
import type { TechnologyEnrichmentService } from '../enrichment/technology-enrichment.js';
import { readXEvidenceFacts, readTechnologyEvidenceFacts, readTriggerFacts } from './evidence-readers.js';

/**
 * Evidence Assembly + Scoring Integration — BUILD_PLAN.md Stage 4C.
 *
 *   X discovery evidence (Stage 4B) ─┐
 *                                     ├─> EvidenceFact[] / TriggerFact[] ─> normalizeEvidenceForScoring() ─> scoreProspect() ─> icp_scores row
 *   Technology detections (Stage 2) ─┘        (unchanged, Stage 3)              (unchanged, Stage 3)
 *
 * This service only reads existing evidence and orchestrates the existing
 * `TechnologyEnrichmentService` (never `opentechalyzer`/`TechAnalyzerAdapter`
 * directly) and the existing Stage 3 scoring contract (never a second
 * scoring implementation). See `evidence-readers.ts` for exactly which
 * fixed signal categories are populated and why several ICP categories are
 * deliberately left unpopulated (documented gaps, not silent omissions).
 */

export interface AssembleAndScoreOptions {
  /** ICP §15/§22.B facts no current pipeline stage establishes (see evidence-readers.ts) — always false unless a caller has independently verified one, never auto-derived from weak X observations. */
  exclusionOverrides?: Partial<ExclusionEvidence>;
  /** Forces a fresh technology scan even when a successful one already exists. Default false — reuse existing scans per instruction (avoid rescanning domains unnecessarily). */
  forceRescan?: boolean;
  analyzeOptions?: TechAnalyzeOptions;
}

export interface AssembleAndScoreResult {
  prospectId: string;
  icpScoreId: string;
  scoreResult: IcpScoreResult;
  /** True only when a new technology scan was actually performed this call (false when an existing successful scan was reused, or no domain was available). */
  technologyScanPerformed: boolean;
}

export interface ScoreBatchOptions {
  resumeJobId?: string;
  exclusionOverrides?: Partial<ExclusionEvidence>;
  forceRescan?: boolean;
}

export interface ScoreBatchProspectOutcome {
  prospectId: string;
  icpScoreId?: string;
  score?: number | null;
  tier?: IcpScoreResult['tier'];
  error?: string;
}

export interface ScoreBatchOutcome {
  jobId: string;
  results: ScoreBatchProspectOutcome[];
}

interface BatchCheckpoint {
  completed: Record<string, { icpScoreId?: string; score?: number | null; tier?: IcpScoreResult['tier']; error?: string }>;
}

export const EVIDENCE_ASSEMBLY_BATCH_JOB_TYPE = 'evidence_assembly_batch';

const NO_EXCLUSION_EVIDENCE: ExclusionEvidence = {
  notDtcEcommerce: false,
  noPaidAcquisitionActivityDetected: false,
  companyAppearsDefunct: false,
  onlyContactHasNoBudgetAuthority: false,
};

export class EvidenceAssemblyService {
  private readonly jobRunner: JobRunner;

  constructor(
    private readonly db: MetrivioDb,
    private readonly technologyEnrichment: TechnologyEnrichmentService,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.jobRunner = new JobRunner(db, logger);
  }

  /**
   * Assembles evidence for one prospect and produces + persists one
   * `icp_scores` row. Never overwrites a prior score — DATABASE.md's own
   * design keeps scoring history, so a re-run appends a new row rather than
   * updating the last one; every score remains reproducible from the
   * evidence state at the time it was computed.
   */
  async assembleAndScore(prospectId: string, options: AssembleAndScoreOptions = {}): Promise<AssembleAndScoreResult> {
    const prospectRows = await this.db.select().from(schema.prospects).where(eq(schema.prospects.id, prospectId)).limit(1);
    const prospect = prospectRows[0];
    if (!prospect) {
      throw new Error(`Cannot assemble evidence: no prospect found with id ${prospectId}`);
    }

    let technologyScanPerformed = false;
    const domain = prospect.companyDomain;
    if (domain) {
      const alreadyScanned = await this.hasSuccessfulScan(domain);
      if (!alreadyScanned || options.forceRescan) {
        await this.technologyEnrichment.scanDomain(domain, { prospectId, analyzeOptions: options.analyzeOptions });
        technologyScanPerformed = true;
      }
    }

    const [xFacts, techFacts, triggers] = await Promise.all([
      readXEvidenceFacts(this.db, prospectId),
      domain ? readTechnologyEvidenceFacts(this.db, domain) : Promise.resolve([]),
      readTriggerFacts(this.db, prospectId),
    ]);

    const exclusions: ExclusionEvidence = { ...NO_EXCLUSION_EVIDENCE, ...options.exclusionOverrides };

    const normalized = normalizeEvidenceForScoring({ facts: [...xFacts, ...techFacts], triggers, exclusions });
    const scoreResult = scoreProspect(normalized);

    const icpScoreId = uuid();
    await this.db.insert(schema.icpScores).values({
      id: icpScoreId,
      prospectId,
      score: scoreResult.score,
      tier: scoreResult.tier,
      exclusionTriggered: scoreResult.exclusionTriggered,
      exclusionReason: scoreResult.exclusionReason ?? null,
      factorBreakdown: JSON.stringify(scoreResult.factorBreakdown),
      revenueDisclosureStatus: scoreResult.revenueDisclosureStatus,
      spendDisclosureStatus: scoreResult.spendDisclosureStatus,
      missingEvidence: JSON.stringify(scoreResult.missingEvidence),
      recommendedAction: scoreResult.recommendedAction,
      scoringEngineVersion: scoreResult.scoringEngineVersion,
    });

    this.logger?.info(
      { prospectId, icpScoreId, score: scoreResult.score, tier: scoreResult.tier, technologyScanPerformed },
      'evidence_assembly.scored'
    );

    return { prospectId, icpScoreId, scoreResult, technologyScanPerformed };
  }

  private async hasSuccessfulScan(companyDomain: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(schema.technologyScans)
      .where(and(eq(schema.technologyScans.companyDomain, companyDomain), eq(schema.technologyScans.scanStatus, 'OK')))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Batch evidence-assembly + scoring over the existing `job_runs`
   * mechanism (mirrors `TechnologyEnrichmentService.scanBatch`'s pattern
   * exactly — same checkpoint-per-item, resumable design, no second job
   * system). Each prospect's outcome (including a per-prospect failure) is
   * persisted to the checkpoint immediately, so a crash mid-batch loses
   * nothing already scored.
   */
  async scoreBatch(prospectIds: string[], options: ScoreBatchOptions = {}): Promise<ScoreBatchOutcome> {
    let jobId: string;
    let checkpoint: BatchCheckpoint;

    if (options.resumeJobId) {
      const existing = await this.jobRunner.get(options.resumeJobId);
      if (!existing) {
        throw new Error(`Cannot resume evidence-assembly batch: no job_run found with id ${options.resumeJobId}`);
      }
      jobId = existing.id;
      checkpoint = (existing.checkpoint as BatchCheckpoint | null) ?? { completed: {} };
      await this.jobRunner.markResumed(jobId);
    } else {
      checkpoint = { completed: {} };
      jobId = await this.jobRunner.start(EVIDENCE_ASSEMBLY_BATCH_JOB_TYPE, checkpoint);
    }

    const pending = prospectIds.filter((id) => !(id in checkpoint.completed));
    for (const prospectId of pending) {
      try {
        const result = await this.assembleAndScore(prospectId, {
          exclusionOverrides: options.exclusionOverrides,
          forceRescan: options.forceRescan,
        });
        checkpoint.completed[prospectId] = {
          icpScoreId: result.icpScoreId,
          score: result.scoreResult.score,
          tier: result.scoreResult.tier,
        };
      } catch (err) {
        checkpoint.completed[prospectId] = { error: err instanceof Error ? err.message : String(err) };
      }
      await this.jobRunner.updateCheckpoint(jobId, checkpoint);
    }

    await this.jobRunner.complete(jobId);

    const results: ScoreBatchProspectOutcome[] = prospectIds.map((prospectId) => {
      const entry = checkpoint.completed[prospectId];
      if (!entry) return { prospectId, error: 'prospect was not processed by this batch run' };
      return { prospectId, ...entry };
    });

    return { jobId, results };
  }
}
