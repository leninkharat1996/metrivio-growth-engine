import { and, eq, desc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  JobRunner,
  schema,
  type MetrivioDb,
  type TechAnalyzerAdapter,
  type TechAnalyzeOptions,
  type TechAnalyzerResult,
  type createLogger,
} from '@metrivio/core';

/**
 * Technology enrichment — ARCHITECTURE.md §3.1 "Enrich" stage, scoped to the
 * Company Domain → TechAnalyzerAdapter → Normalized Technology Evidence →
 * Persistence → Change Detection flow only (BUILD_PLAN.md Stage 2's
 * TechAnalyzerAdapter item). Discovery, ICP scoring, and personalization are
 * later stages and are not implemented here.
 *
 * This service depends only on the `TechAnalyzerAdapter` interface, never on
 * `opentechalyzer` directly — per ARCHITECTURE.md §1's "adapters around
 * everything fragile" principle, business/persistence logic never touches
 * the underlying detector.
 */

export interface TechnologyScanRecord {
  scanId: string;
  companyDomain: string;
  prospectId: string | null;
  scanStatus: TechAnalyzerResult['scanStatus'];
  detector: TechAnalyzerResult['detector'];
  technologies: TechAnalyzerResult['technologies'];
  scannedAt: string;
}

export interface ScanDomainOptions {
  prospectId?: string;
  analyzeOptions?: TechAnalyzeOptions;
}

export interface TechnologyChangeRecord {
  id: string;
  companyDomain: string;
  prospectId: string | null;
  earlierScanId: string;
  laterScanId: string;
  technologyName: string;
  changeType: 'added' | 'removed';
  detectedAt: string;
}

export interface BatchScanOptions {
  analyzeOptions?: TechAnalyzeOptions;
  /** Bounded concurrency for this service's own domain loop. Defaults to 5, matching opentechalyzer's own analyzeMany() default — never invent a larger limit than the library itself uses by default. */
  concurrency?: number;
  /** An existing job_runs id to resume instead of starting a new batch. */
  resumeJobId?: string;
}

interface BatchCheckpointEntry {
  scanId?: string;
  scanStatus?: TechAnalyzerResult['scanStatus'];
  error?: string;
}

interface BatchCheckpoint {
  completed: Record<string, BatchCheckpointEntry>;
}

export interface BatchScanDomainResult {
  companyDomain: string;
  scanId?: string;
  scanStatus?: TechAnalyzerResult['scanStatus'];
  error?: string;
}

export interface BatchScanOutcome {
  jobId: string;
  results: BatchScanDomainResult[];
}

export const TECHNOLOGY_ENRICHMENT_BATCH_JOB_TYPE = 'technology_enrichment_batch';

export class TechnologyEnrichmentService {
  private readonly jobRunner: JobRunner;

  constructor(
    private readonly db: MetrivioDb,
    private readonly adapter: TechAnalyzerAdapter,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.jobRunner = new JobRunner(db, logger);
  }

  /**
   * Runs a single scan, persists the `technology_scans` row (always) and its
   * `technology_detections` rows (only when `scanStatus === 'OK'`, matching
   * DATABASE.md exactly — a failed scan writes zero detection rows), then
   * runs change detection against the domain's prior successful scan.
   */
  async scanDomain(companyDomain: string, opts: ScanDomainOptions = {}): Promise<TechnologyScanRecord> {
    let result: TechAnalyzerResult;
    try {
      result = await this.adapter.analyze(companyDomain, opts.analyzeOptions);
    } catch (err) {
      // A conforming TechAnalyzerAdapter should never throw — ERROR is a
      // resolved scanStatus value (ARCHITECTURE.md §6) — but an unexpected
      // throw must still persist a durable ERROR row rather than crash the
      // caller's pipeline or a batch run.
      this.logger?.error(
        { companyDomain, err: err instanceof Error ? err.message : String(err) },
        'technology_scan.adapter_threw_unexpectedly'
      );
      result = {
        scanStatus: 'ERROR',
        technologies: [],
        detector: 'open_tech_analyzer',
        timestamp: new Date().toISOString(),
      };
    }

    const scanId = uuid();
    const scannedAt = new Date().toISOString();
    const prospectId = opts.prospectId ?? null;

    await this.db.insert(schema.technologyScans).values({
      id: scanId,
      prospectId,
      companyDomain,
      scanStatus: result.scanStatus,
      detector: result.detector,
      renderUsed: opts.analyzeOptions?.render ?? true,
      crawlUsed: opts.analyzeOptions?.crawl ?? 5,
      // The full normalized adapter result, retained for audit/debugging
      // (DATABASE.md `technology_scans.raw_response`). This is the fullest
      // payload available at this layer without reaching around the
      // TechAnalyzerAdapter boundary into the underlying detector library.
      rawResponse: JSON.stringify(result),
      scannedAt,
    });

    if (result.scanStatus === 'OK') {
      for (const tech of result.technologies) {
        await this.db.insert(schema.technologyDetections).values({
          id: uuid(),
          scanId,
          technologyName: tech.name,
          status: tech.status,
          confidence: tech.confidence,
          accountIds: tech.accountIds ? JSON.stringify(tech.accountIds) : null,
          evidence: JSON.stringify(tech.evidence),
          inferred: tech.inferred ?? false,
        });
      }
      await this.detectChanges(companyDomain, scanId, prospectId);
    }

    this.logger?.info(
      { companyDomain, scanId, scanStatus: result.scanStatus, technologyCount: result.technologies.length },
      'technology_scan.completed'
    );

    return {
      scanId,
      companyDomain,
      prospectId,
      scanStatus: result.scanStatus,
      detector: result.detector,
      technologies: result.technologies,
      scannedAt,
    };
  }

  /**
   * Diffs the just-written successful scan against the domain's most recent
   * prior successful scan (DATABASE.md `technology_change_events` — "both
   * scan_status = OK"), writing `added`/`removed` rows.
   *
   * `version_changed` (documented as a valid `change_type` in DATABASE.md)
   * is deliberately NOT implemented here: neither the Stage-1-defined
   * `TechnologyResult`/`TechEvidenceItem` adapter-contract types
   * (packages/core/src/adapters/tech-analyzer-adapter.ts) nor the
   * `technology_detections` table carry a `version` field anywhere, even
   * though OpenTechAnalyzer's own `Detection.version` is available at the
   * adapter's source. Adding one would be an adapter-contract and/or schema
   * change, which the Stage 2 instructions require stopping and reporting
   * rather than silently making — see the Stage 2 completion report.
   */
  private async detectChanges(companyDomain: string, laterScanId: string, prospectId: string | null): Promise<void> {
    const priorOkScans = await this.db
      .select()
      .from(schema.technologyScans)
      .where(and(eq(schema.technologyScans.companyDomain, companyDomain), eq(schema.technologyScans.scanStatus, 'OK')))
      .orderBy(desc(schema.technologyScans.scannedAt));

    const earlier = priorOkScans.find((s) => s.id !== laterScanId);
    if (!earlier) return; // first successful scan for this domain — nothing to diff against yet

    const [earlierDetections, laterDetections] = await Promise.all([
      this.db.select().from(schema.technologyDetections).where(eq(schema.technologyDetections.scanId, earlier.id)),
      this.db.select().from(schema.technologyDetections).where(eq(schema.technologyDetections.scanId, laterScanId)),
    ]);

    const earlierDetectedNames = new Set(
      earlierDetections.filter((d) => d.status === 'DETECTED').map((d) => d.technologyName)
    );
    const laterDetectedNames = new Set(
      laterDetections.filter((d) => d.status === 'DETECTED').map((d) => d.technologyName)
    );

    const now = new Date().toISOString();

    for (const name of laterDetectedNames) {
      if (!earlierDetectedNames.has(name)) {
        await this.db.insert(schema.technologyChangeEvents).values({
          id: uuid(),
          prospectId,
          companyDomain,
          earlierScanId: earlier.id,
          laterScanId,
          technologyName: name,
          changeType: 'added',
          detectedAt: now,
        });
      }
    }

    for (const name of earlierDetectedNames) {
      if (!laterDetectedNames.has(name)) {
        await this.db.insert(schema.technologyChangeEvents).values({
          id: uuid(),
          prospectId,
          companyDomain,
          earlierScanId: earlier.id,
          laterScanId,
          technologyName: name,
          changeType: 'removed',
          detectedAt: now,
        });
      }
    }
  }

  /**
   * Batch enrichment over the `job_runs` mechanism (BUILD_PLAN.md Stage 2 —
   * "support retry/resume through the existing job/run mechanism"). Each
   * domain is scanned and persisted individually (via `scanDomain`), with
   * the checkpoint updated after every domain completes — so a crash mid
   * batch loses nothing already scanned, and `resumeJobId` lets a later call
   * pick up exactly the domains not yet in the checkpoint.
   *
   * This deliberately does not delegate to `TechAnalyzerAdapter.analyzeMany`
   * even though that method exists and is tested: `analyzeMany()` resolves
   * only once every URL is done, which is incompatible with true per-domain
   * incremental persistence and checkpointing. The same bounded-concurrency
   * pattern opentechalyzer's own `analyzeMany()` uses internally is
   * reimplemented here directly against `analyze()` instead, so every
   * completed domain is durably persisted before the next one starts.
   */
  async scanBatch(domains: string[], opts: BatchScanOptions = {}): Promise<BatchScanOutcome> {
    let jobId: string;
    let checkpoint: BatchCheckpoint;

    if (opts.resumeJobId) {
      const existing = await this.jobRunner.get(opts.resumeJobId);
      if (!existing) {
        throw new Error(`Cannot resume technology enrichment batch: no job_run found with id ${opts.resumeJobId}`);
      }
      jobId = existing.id;
      checkpoint = (existing.checkpoint as BatchCheckpoint | null) ?? { completed: {} };
      await this.jobRunner.markResumed(jobId);
    } else {
      checkpoint = { completed: {} };
      jobId = await this.jobRunner.start(TECHNOLOGY_ENRICHMENT_BATCH_JOB_TYPE, checkpoint);
    }

    const pending = domains.filter((d) => !(d in checkpoint.completed));
    const concurrency = Math.max(1, opts.concurrency ?? 5);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const domain = pending[index];
        if (domain === undefined) return;
        try {
          const record = await this.scanDomain(domain, { analyzeOptions: opts.analyzeOptions });
          checkpoint.completed[domain] = { scanId: record.scanId, scanStatus: record.scanStatus };
        } catch (err) {
          // scanDomain already contains adapter-level failures internally
          // (they resolve as an ERROR scanStatus row); this branch only
          // fires on a persistence-layer failure for this specific domain
          // (e.g. a DB write error), and is recorded per-domain so it can
          // never lose already-completed results for the rest of the batch.
          checkpoint.completed[domain] = { error: err instanceof Error ? err.message : String(err) };
        }
        await this.jobRunner.updateCheckpoint(jobId, checkpoint);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    await this.jobRunner.complete(jobId);

    const results: BatchScanDomainResult[] = domains.map((domain) => {
      const entry = checkpoint.completed[domain];
      if (!entry) return { companyDomain: domain, error: 'domain was not processed by this batch run' };
      return { companyDomain: domain, scanId: entry.scanId, scanStatus: entry.scanStatus, error: entry.error };
    });

    return { jobId, results };
  }

  /** Reads back the technology_change_events rows for a domain, most recent first. */
  async getChangeEvents(companyDomain: string): Promise<TechnologyChangeRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.technologyChangeEvents)
      .where(eq(schema.technologyChangeEvents.companyDomain, companyDomain))
      .orderBy(desc(schema.technologyChangeEvents.detectedAt));
    return rows.map((r) => ({
      id: r.id,
      companyDomain: r.companyDomain,
      prospectId: r.prospectId,
      earlierScanId: r.earlierScanId,
      laterScanId: r.laterScanId,
      technologyName: r.technologyName,
      changeType: r.changeType as 'added' | 'removed',
      detectedAt: r.detectedAt,
    }));
  }
}
