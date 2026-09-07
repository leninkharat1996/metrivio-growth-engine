import type { JobHandler, JobHandlerContext, JobHandlerResult } from '@metrivio/core';
import { GrowthTechniqueLearningService } from '../analytics/growth-technique-learning-service.js';
import { UPDATE_GROWTH_TECHNIQUES_JOB_TYPE } from './job-types.js';

/**
 * Stage 9, Section L — `UPDATE_GROWTH_TECHNIQUES`. Thin automation wrapper
 * around `GrowthTechniqueLearningService`, which itself only ever reuses
 * Stage 7's own `deriveTechniqueStatus()` — this job invents no new
 * promotion rule, and (per that service's own doc comment) never advances
 * a technique's status from mere repeated EXPERT usage.
 */
export class UpdateGrowthTechniquesHandler implements JobHandler {
  readonly jobType = UPDATE_GROWTH_TECHNIQUES_JOB_TYPE;

  constructor(private readonly learning: GrowthTechniqueLearningService) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    if (ctx.dryRun) {
      return { itemsProcessed: 0, itemsSucceeded: 0, itemsFailed: 0, detail: { dryRun: true, note: 'would review own-hook-type performance and record/update growth-technique entries — no audit_log writes performed' } };
    }

    const recorded = await this.learning.learnFromOwnPerformance();
    return { itemsProcessed: recorded.length, itemsSucceeded: recorded.length, itemsFailed: 0, detail: { recordedCount: recorded.length } };
  }
}
