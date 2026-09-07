import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { ContentRecommendationEngine } from '../analytics/content-recommendation-engine.js';
import { GENERATE_CONTENT_RECOMMENDATIONS_JOB_TYPE } from './job-types.js';

/**
 * Stage 9, Section M/S — `GENERATE_CONTENT_RECOMMENDATIONS`. Runs the
 * read-only `ContentRecommendationEngine` and records the ranked output
 * to `audit_log` for the dashboard to display. Recommendations remain
 * recommendations (Section S): this job never creates a draft, never
 * approves anything, and never touches `content_ideas.status` — a human
 * decides what to actually act on.
 */
export class GenerateContentRecommendationsHandler implements JobHandler {
  readonly jobType = GENERATE_CONTENT_RECOMMENDATIONS_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly recommendations: ContentRecommendationEngine
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const recs = await this.recommendations.generateRecommendations();
    const bounded = recs.slice(0, ctx.maxItems);

    if (!ctx.dryRun) {
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'content.recommendations.generated',
        entityType: 'content_recommendation_run',
        detail: { runId: ctx.runId, count: bounded.length, recommendations: bounded },
      });
    }

    return { itemsProcessed: bounded.length, itemsSucceeded: bounded.length, itemsFailed: 0, detail: { count: bounded.length } };
  }
}
