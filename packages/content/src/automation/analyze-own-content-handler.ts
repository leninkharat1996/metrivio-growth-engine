import type { JobHandler, JobHandlerContext, JobHandlerResult } from '@metrivio/core';
import { OwnContentPerformanceService } from '../own-content/own-content-performance-service.js';
import { ANALYZE_OWN_CONTENT_JOB_TYPE } from './job-types.js';

/**
 * Stage 7, Section Z/S — `ANALYZE_OWN_CONTENT`. Wraps
 * `OwnContentPerformanceService.analyzeTopPosts()` over every post id that
 * has ever had a performance snapshot ingested. As documented throughout
 * this package, there is no live data yet (no verified publishing
 * transport — Section Y) — this job is exercised against injected test
 * data only, never claimed as live-tested.
 */
export class AnalyzeOwnContentHandler implements JobHandler {
  readonly jobType = ANALYZE_OWN_CONTENT_JOB_TYPE;

  constructor(private readonly performance: OwnContentPerformanceService) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const postIds = (await this.performance.listIngestedPostIds()).slice(0, ctx.maxItems);
    const summaries = await this.performance.analyzeTopPosts(postIds);
    return {
      itemsProcessed: postIds.length,
      itemsSucceeded: summaries.length,
      itemsFailed: postIds.length - summaries.length,
      detail: { topPostId: summaries[0]?.postId ?? null },
    };
  }
}
