import { eq } from 'drizzle-orm';
import { schema, writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { SchedulingReadinessService } from '../publishing/scheduling-readiness.js';
import { PublishApprovedContentService } from '../publishing/publish-approved-content-service.js';
import { PUBLISH_DUE_CONTENT_JOB_TYPE } from './job-types.js';

/**
 * Stage 8, Section T — `PUBLISH_DUE_CONTENT`, the minimum publishing
 * automation job. Its ONLY two responsibilities are (1) find which
 * already-APPROVED, already-ready-for-scheduling, not-yet-published drafts
 * are now due, and (2) call `PublishApprovedContentService.publishDraft()`
 * for each — every actual safety check (approval integrity, revalidation,
 * kill switch, publishing mode, limits, idempotency) lives in that service,
 * not here. This handler never calls `XPublishAdapter` directly, never
 * calls `submitForApproval()`/`approve()`/`reject()`, and never mutates a
 * draft's body or scheduling state — it only discovers and delegates.
 *
 * Isolated per-item failures never abort the run (Section T: "continues
 * after isolated failures") — one draft throwing does not prevent the
 * remaining due drafts in this run from being attempted.
 */
export class PublishDueContentHandler implements JobHandler {
  readonly jobType = PUBLISH_DUE_CONTENT_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly scheduling: SchedulingReadinessService,
    private readonly publisher: PublishApprovedContentService
  ) {}

  /**
   * Finds `content_drafts` rows that are APPROVED (in the DB), not yet
   * published (`x_manager_post_id IS NULL`), marked ready for scheduling,
   * and due (no `scheduledFor`, or one that has already passed). Bounded by
   * `maxItems` — never scans or processes more than that.
   */
  private async findDueDraftIds(maxItems: number): Promise<string[]> {
    const approvedRows = await this.db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.approvalStatus, 'approved'));
    const due: string[] = [];
    for (const row of approvedRows) {
      if (row.xManagerPostId) continue; // already published — idempotency short-circuit before even calling the service
      const state = await this.scheduling.getSchedulingState(row.id);
      if (!state.readyForScheduling) continue;
      if (state.scheduledFor && new Date(state.scheduledFor).getTime() > Date.now()) continue;
      due.push(row.id);
      if (due.length >= maxItems) break;
    }
    return due;
  }

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const dueDraftIds = await this.findDueDraftIds(ctx.maxItems);

    let succeeded = 0;
    let failed = 0;
    const outcomeCounts: Record<string, number> = {};

    for (const draftId of dueDraftIds) {
      try {
        const result = await this.publisher.publishDraft(draftId, { dryRun: ctx.dryRun });
        outcomeCounts[result.outcome] = (outcomeCounts[result.outcome] ?? 0) + 1;
        if (result.outcome === 'PUBLISHED') {
          succeeded += 1;
        } else if (result.outcome === 'FAILED' || result.outcome === 'UNKNOWN') {
          failed += 1;
        }
        // BLOCKED is a correct, intentional skip (not-yet-due-anymore,
        // revalidation failure, limit reached, etc.) — counted in
        // outcomeCounts for visibility but not itemsSucceeded/itemsFailed,
        // since it is neither a bug nor a successful publish.
      } catch (err) {
        // publishDraft() itself is designed to never throw (every path
        // returns a PublishResult) — this only guards against a genuinely
        // unexpected failure, so an isolated bad draft never aborts the run.
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.content_publish.failed',
          entityType: 'content_draft',
          entityId: draftId,
          dryRun: ctx.dryRun,
          detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return { itemsProcessed: dueDraftIds.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { outcomeCounts } };
  }
}
