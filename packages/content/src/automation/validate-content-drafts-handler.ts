import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { ContentDraftService } from '../drafts/content-draft-service.js';
import { VALIDATE_CONTENT_DRAFTS_JOB_TYPE } from './job-types.js';

/** Stage 7, Section Z/I — `VALIDATE_CONTENT_DRAFTS`. Re-runs validation on every non-terminal draft (Section G's fresh-research-may-change-things case), never touching approval state. */
export class ValidateContentDraftsHandler implements JobHandler {
  readonly jobType = VALIDATE_CONTENT_DRAFTS_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly drafts: ContentDraftService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const nonTerminal = await this.drafts.listNonTerminalDrafts(ctx.maxItems);
    let succeeded = 0;
    let failed = 0;
    let newlyFlagged = 0;

    for (const draft of nonTerminal) {
      try {
        const before = draft.qualityCheckStatus;
        const updated = await this.drafts.revalidate(draft.id);
        if (before === 'pass' && updated.qualityCheckStatus === 'flagged') newlyFlagged += 1;
        succeeded += 1;
      } catch (err) {
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.content_draft_validation.failed',
          entityType: 'content_draft',
          entityId: draft.id,
          dryRun: ctx.dryRun,
          detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return { itemsProcessed: nonTerminal.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { newlyFlagged } };
  }
}
