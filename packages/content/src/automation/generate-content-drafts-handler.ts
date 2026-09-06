import { eq } from 'drizzle-orm';
import { schema, writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { ContentDraftService } from '../drafts/content-draft-service.js';
import { GENERATE_CONTENT_DRAFTS_JOB_TYPE } from './job-types.js';

/**
 * Stage 7, Section Z/O/W — `GENERATE_CONTENT_DRAFTS`. Finds `content_ideas`
 * rows still in `status: 'new'` with no draft yet, and calls
 * `ContentDraftService.generateDraft()` for each (bounded). The draft body
 * itself is deterministically assembled from the idea's own `hook`/`angle`/
 * `why_it_matters` fields — never inventing new claims beyond what
 * `ContentOpportunityEngine` already put there. Every generated draft
 * lands at `DRAFTED` only — this job never calls `submitForApproval()` or
 * `approve()` (Section K/W: automation must never manufacture approval;
 * unlike the outreach follow-up automation, content drafts here are left
 * for a human to explicitly submit, since content approval carries no
 * eligibility-recheck concept that would justify auto-submitting).
 *
 * Dry-run (Section D): reports which ideas WOULD get a draft, creates
 * nothing.
 */
export class GenerateContentDraftsHandler implements JobHandler {
  readonly jobType = GENERATE_CONTENT_DRAFTS_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly drafts: ContentDraftService
  ) {}

  private async findIdeasNeedingDrafts(maxItems: number): Promise<Array<typeof schema.contentIdeas.$inferSelect>> {
    const ideas = await this.db.select().from(schema.contentIdeas).where(eq(schema.contentIdeas.status, 'new'));
    const needDrafts: Array<typeof schema.contentIdeas.$inferSelect> = [];
    for (const idea of ideas) {
      const existing = await this.drafts.listDraftsForIdea(idea.id);
      if (existing.length === 0) needDrafts.push(idea);
      if (needDrafts.length >= maxItems) break;
    }
    return needDrafts;
  }

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const ideas = await this.findIdeasNeedingDrafts(ctx.maxItems);

    if (ctx.dryRun) {
      return { itemsProcessed: ideas.length, itemsSucceeded: ideas.length, itemsFailed: 0, detail: { wouldDraftIdeaIds: ideas.map((i) => i.id) } };
    }

    let succeeded = 0;
    let failed = 0;
    let flaggedCount = 0;

    for (const idea of ideas) {
      try {
        const body = `${idea.hook ?? idea.topic}\n\n${idea.whyItMatters ?? ''}`.trim();
        const { draft } = await this.drafts.generateDraft({ ideaId: idea.id, body, chosenHook: idea.hook ?? undefined });
        if (draft.qualityCheckStatus === 'flagged') flaggedCount += 1;
        succeeded += 1;
      } catch (err) {
        failed += 1;
        await writeAuditLog(this.db, {
          actor: 'system',
          actionType: 'automation.content_draft_generation.failed',
          entityType: 'content_idea',
          entityId: idea.id,
          dryRun: false,
          detail: { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return { itemsProcessed: ideas.length, itemsSucceeded: succeeded, itemsFailed: failed, detail: { flaggedCount } };
  }
}
