import type { JobHandler, JobHandlerContext, JobHandlerResult } from '@metrivio/core';
import { ContentOpportunityEngine } from '../opportunities/content-opportunity-engine.js';
import { GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE } from './job-types.js';

/** Stage 7, Section Z/L — `GENERATE_CONTENT_OPPORTUNITIES`. Wraps `ContentOpportunityEngine.generateOpportunities()` (Section V's own evidence gate already refuses an unsupported opportunity — nothing extra to bound here beyond the engine's own `maxSignalsScanned`). */
export class GenerateContentOpportunitiesHandler implements JobHandler {
  readonly jobType = GENERATE_CONTENT_OPPORTUNITIES_JOB_TYPE;

  constructor(private readonly engine: ContentOpportunityEngine) {}

  async run(ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const opportunities = await this.engine.generateOpportunities({ maxSignalsScanned: ctx.maxItems * 20 });
    return { itemsProcessed: opportunities.length, itemsSucceeded: opportunities.length, itemsFailed: 0, detail: { topScore: opportunities[0]?.score ?? null } };
  }
}
