import { writeAuditLog, type MetrivioDb, type JobHandler, type JobHandlerContext, type JobHandlerResult } from '@metrivio/core';
import { PerformanceAnalysisService } from '../analytics/performance-analysis-service.js';
import { ANALYZE_CONTENT_PERFORMANCE_JOB_TYPE } from './job-types.js';

/**
 * Stage 9, Section E/I/J/R — `ANALYZE_CONTENT_PERFORMANCE`. Pure
 * read/aggregate over already-ingested performance snapshots
 * (`PerformanceAnalysisService`, itself read-only) — this job never
 * mutates a draft, an approval, or a published post; it only records its
 * grouped findings to `audit_log` so the dashboard and a human reviewer
 * can see them without recomputing on every page load.
 */
export class AnalyzeContentPerformanceHandler implements JobHandler {
  readonly jobType = ANALYZE_CONTENT_PERFORMANCE_JOB_TYPE;

  constructor(
    private readonly db: MetrivioDb,
    private readonly performance: PerformanceAnalysisService
  ) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const analysis = await this.performance.analyze();

    if (!ctx.dryRun) {
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'content.performance_analysis.completed',
        entityType: 'content_performance_analysis',
        detail: {
          runId: ctx.runId,
          overallBaselineScore: analysis.overallBaselineScore,
          totalPostsAnalyzed: analysis.totalPostsAnalyzed,
          byTopic: analysis.byTopic,
          byPillar: analysis.byPillar,
          byHookType: analysis.byHookType,
          byFormat: analysis.byFormat,
          byCtaType: analysis.byCtaType,
        },
      });
    }

    return { itemsProcessed: analysis.totalPostsAnalyzed, itemsSucceeded: analysis.totalPostsAnalyzed, itemsFailed: 0, detail: { overallBaselineScore: analysis.overallBaselineScore } };
  }
}
