import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { DueWorkDiscoveryService, type DueFollowUpStatus } from './due-work-discovery-service.js';
import { DISCOVER_DUE_FOLLOWUPS_JOB_TYPE } from './job-types.js';

/**
 * Stage 6E, Section H — the `DISCOVER_DUE_FOLLOWUPS` job. Read-only from
 * this handler's own perspective: it never creates a draft and never
 * writes `outreach_messages`. (It does, transitively, run Stage 6C's reply
 * detection, which persists any newly observed inbound message to
 * `conversation_messages` — that write already exists and is already safe
 * by Stage 6C's own design; this handler adds no new write of its own.)
 *
 * `itemsSucceeded`/`itemsFailed` are about *processing*, not business
 * outcome — a candidate correctly evaluated as `NOT_DUE`/`REPLIED`/etc. is
 * a processing success; only a hard failure during evaluation (`ERROR`)
 * counts against `itemsFailed` (Section Q).
 */
export class DiscoverDueFollowUpsHandler implements JobHandler {
  readonly jobType = DISCOVER_DUE_FOLLOWUPS_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly discovery: DueWorkDiscoveryService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const { results } = await this.discovery.findDueFollowUps({ maxCandidates: ctx.maxItems, maxReplyChecks: ctx.maxItems });

    const byStatus: Partial<Record<DueFollowUpStatus, number>> = {};
    let succeeded = 0;
    let failed = 0;

    for (const result of results) {
      byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
      if (result.status === 'ERROR') {
        failed += 1;
      } else {
        succeeded += 1;
      }
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'automation.due_followup.checked',
        entityType: 'prospect',
        entityId: result.prospectId,
        dryRun: ctx.dryRun,
        detail: { runId: ctx.runId, sequenceId: result.sequenceId, status: result.status },
      });
    }

    await ctx.updateCheckpoint({ lastRunResultCounts: byStatus });

    return { itemsProcessed: results.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { byStatus } };
  }
}
