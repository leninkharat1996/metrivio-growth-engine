import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { IcpResearchService } from '../icp-research/icp-research-service.js';
import { findIcpResearchCandidates } from './icp-candidate-discovery.js';
import { INGEST_CONTENT_SIGNALS_JOB_TYPE } from './job-types.js';

/**
 * Stage 7, Section Z — `INGEST_CONTENT_SIGNALS`. Wraps
 * `IcpResearchService.researchProspect()` (Section A: reuses existing
 * `prospects`, never a second discovery pass) over a bounded, deterministic
 * candidate list. One prospect failing never aborts the run (Section Q).
 */
export class IngestContentSignalsHandler implements JobHandler {
  readonly jobType = INGEST_CONTENT_SIGNALS_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly icpResearch: IcpResearchService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const candidates = await findIcpResearchCandidates(this.db, ctx.maxItems);
    let succeeded = 0;
    let failed = 0;
    let signalsCreated = 0;

    for (const prospectId of candidates) {
      try {
        const signals = await this.icpResearch.researchProspect(prospectId);
        signalsCreated += signals.length;
        succeeded += 1;
      } catch (err) {
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.content_signal_ingest.failed',
          entityType: 'prospect',
          entityId: prospectId,
          dryRun: ctx.dryRun,
          detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return { itemsProcessed: candidates.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { signalsCreated } };
  }
}
