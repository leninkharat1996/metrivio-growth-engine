import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { TrackedAccountStore } from '../accounts/tracked-account-store.js';
import { TrackedAccountResearchService } from '../accounts/tracked-account-research-service.js';
import { ANALYZE_COMPETITOR_CONTENT_JOB_TYPE } from './job-types.js';

/**
 * Stage 7, Section Z/G — `ANALYZE_COMPETITOR_CONTENT`. Runs
 * `TrackedAccountResearchService.researchAccount()` (Section G) across
 * every tracked, active competitor account, bounded by `ctx.maxItems`.
 * One account failing never aborts the run.
 */
export class AnalyzeCompetitorContentHandler implements JobHandler {
  readonly jobType = ANALYZE_COMPETITOR_CONTENT_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly accounts: TrackedAccountStore,
    private readonly research: TrackedAccountResearchService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const competitors = (await this.accounts.listByType('competitor')).slice(0, ctx.maxItems);
    let succeeded = 0;
    let failed = 0;
    let signalsCreated = 0;

    for (const account of competitors) {
      try {
        const signals = await this.research.researchAccount(account.id);
        signalsCreated += signals.length;
        succeeded += 1;
      } catch (err) {
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.competitor_analysis.failed',
          entityType: 'content_tracked_account',
          entityId: account.id,
          dryRun: ctx.dryRun,
          detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return { itemsProcessed: competitors.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { signalsCreated } };
  }
}
