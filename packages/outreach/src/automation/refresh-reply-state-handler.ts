import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { ReplyDetectionService } from '../follow-up/reply-detection-service.js';
import { findActiveSequenceCandidates } from './candidate-discovery.js';
import { REFRESH_REPLY_STATE_JOB_TYPE } from './job-types.js';

/**
 * Stage 6E, Section I — the `REFRESH_REPLY_STATE` job. Delegates every
 * unit of work to Stage 6C's `ReplyDetectionService.detectReplies()` — no
 * second X-inbox implementation, no re-derivation of reply state. This
 * handler calls the single-prospect method (not `detectRepliesBatch`) in a
 * loop so that the *scheduler's* `job_runs` row (created by
 * `AutomationScheduler`) is the only job-run record for this operation —
 * avoiding a second, nested job-run bookkeeping layer for what is already
 * one bounded, checkpointed run.
 *
 * A failed detection attempt for one prospect is recorded as `UNKNOWN` by
 * `ReplyDetectionService` itself (never `NO_REPLY` — Stage 6C's own
 * invariant) and never aborts the loop (Section Q) — this handler still
 * wraps the call in try/catch in case the prospect record itself is
 * missing or the service throws for an unexpected reason.
 */
export class RefreshReplyStateHandler implements JobHandler {
  readonly jobType = REFRESH_REPLY_STATE_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly replyDetectionService: ReplyDetectionService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const candidates = await findActiveSequenceCandidates(this.db, ctx.maxItems);
    const prospectIds = [...new Set(candidates.map((c) => c.prospectId))].slice(0, ctx.maxItems);

    let succeeded = 0;
    let failed = 0;
    const byReplyState: Record<string, number> = {};

    for (const prospectId of prospectIds) {
      try {
        const result = await this.replyDetectionService.detectReplies(prospectId);
        byReplyState[result.replyState] = (byReplyState[result.replyState] ?? 0) + 1;
        if (result.detectionSucceeded) {
          succeeded += 1;
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.reply_refresh.failed',
          entityType: 'prospect',
          entityId: prospectId,
          dryRun: ctx.dryRun,
          detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    await ctx.updateCheckpoint({ lastRunByReplyState: byReplyState });
    return { itemsProcessed: prospectIds.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { byReplyState } };
  }
}
