import { AutomationScheduler, KillSwitch, SystemConfigService, type MetrivioDb, type XReadAdapter, type XPublishAdapter, type JobHandler, type RunScheduledJobResult, type createLogger } from '@metrivio/core';
import { IcpResearchService } from '../icp-research/icp-research-service.js';
import { TrackedAccountStore } from '../accounts/tracked-account-store.js';
import { TrackedAccountResearchService } from '../accounts/tracked-account-research-service.js';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { ContentOpportunityEngine } from '../opportunities/content-opportunity-engine.js';
import { ContentDraftService } from '../drafts/content-draft-service.js';
import { OwnContentPerformanceService } from '../own-content/own-content-performance-service.js';
import { PersonalBrandAnalysisService } from '../personal-brand/personal-brand-analysis-service.js';
import { SchedulingReadinessService } from '../publishing/scheduling-readiness.js';
import { PublishApprovedContentService } from '../publishing/publish-approved-content-service.js';
import { IngestContentSignalsHandler } from './ingest-content-signals-handler.js';
import { AnalyzeIcpConversationsHandler } from './analyze-icp-conversations-handler.js';
import { AnalyzeCompetitorContentHandler } from './analyze-competitor-content-handler.js';
import { AnalyzeExpertContentHandler } from './analyze-expert-content-handler.js';
import { GenerateContentOpportunitiesHandler } from './generate-content-opportunities-handler.js';
import { GenerateContentDraftsHandler } from './generate-content-drafts-handler.js';
import { ValidateContentDraftsHandler } from './validate-content-drafts-handler.js';
import { AnalyzeOwnContentHandler } from './analyze-own-content-handler.js';
import { PublishDueContentHandler } from './publish-due-content-handler.js';
import { CollectPostPerformanceHandler } from './collect-post-performance-handler.js';
import { AnalyzeContentPerformanceHandler } from './analyze-content-performance-handler.js';
import { UpdateGrowthTechniquesHandler } from './update-growth-techniques-handler.js';
import { GenerateContentRecommendationsHandler } from './generate-content-recommendations-handler.js';
import { PerformanceAnalysisService } from '../analytics/performance-analysis-service.js';
import { GrowthTechniqueLearningService } from '../analytics/growth-technique-learning-service.js';
import { ContentRecommendationEngine } from '../analytics/content-recommendation-engine.js';
import type { ContentAutomationJobType } from './job-types.js';

/**
 * Stage 7, Section Z — reuses Stage 6E's `AutomationScheduler`/`JobRunner`
 * directly (no second scheduler, per instruction). Mirrors
 * `packages/outreach/src/automation/outreach-automation.ts`'s exact same
 * factory/dry-run-resolution pattern, but reuses `content.publishing`'s
 * EXISTING `automation_mode` (Stage 1) instead of `prospecting.outreach`'s
 * — the two subsystems Stage 1 already defined map exactly onto outreach
 * automation (Stage 6E) and content automation (this stage), so no new
 * mode/enabled config concept was needed for either.
 *
 * Stage 8: `xPublishAdapter` is OPTIONAL and additive. When omitted, this
 * factory behaves EXACTLY as it did in Stage 7 (no `PUBLISH_DUE_CONTENT`
 * handler is registered at all, so that job type is simply unavailable —
 * every existing Stage 7 caller/test is unaffected). When provided, one
 * additional handler (`PublishDueContentHandler`) is registered, wired
 * through `PublishApprovedContentService` — never directly to the adapter.
 *
 * Stage 9 registers its four handlers (`COLLECT_POST_PERFORMANCE`,
 * `ANALYZE_CONTENT_PERFORMANCE`, `UPDATE_GROWTH_TECHNIQUES`,
 * `GENERATE_CONTENT_RECOMMENDATIONS`) unconditionally — none of them
 * requires anything beyond the already-required `db`/`xReadAdapter`, and
 * all four are read/analysis-only (the one write any of them performs is
 * `COLLECT_POST_PERFORMANCE`'s own identity-only `icpEngagementCount`
 * refresh — never content, approval, or publish state).
 */
export function createContentAutomationScheduler(
  db: MetrivioDb,
  xReadAdapter: XReadAdapter,
  logger?: ReturnType<typeof createLogger>,
  xPublishAdapter?: XPublishAdapter
): AutomationScheduler {
  const config = new SystemConfigService(db);
  const killSwitch = new KillSwitch(config);

  const icpResearch = new IcpResearchService(db, xReadAdapter, logger);
  const signals = new ContentSignalStore(db);
  const accounts = new TrackedAccountStore(db);
  const accountResearch = new TrackedAccountResearchService(db, xReadAdapter, logger);
  const opportunityEngine = new ContentOpportunityEngine(db);
  const drafts = new ContentDraftService(db, logger);
  const performance = new OwnContentPerformanceService(db, logger);
  const personalBrand = new PersonalBrandAnalysisService(db, xReadAdapter);

  const handlers: JobHandler[] = [
    new IngestContentSignalsHandler(db, icpResearch),
    new AnalyzeIcpConversationsHandler(db, signals),
    new AnalyzeCompetitorContentHandler(db, accounts, accountResearch),
    new AnalyzeExpertContentHandler(db, accounts, accountResearch, personalBrand),
    new GenerateContentOpportunitiesHandler(opportunityEngine),
    new GenerateContentDraftsHandler(db, drafts),
    new ValidateContentDraftsHandler(db, drafts),
    new AnalyzeOwnContentHandler(performance),
    new CollectPostPerformanceHandler(db, xReadAdapter, config),
    new AnalyzeContentPerformanceHandler(db, new PerformanceAnalysisService(db)),
    new UpdateGrowthTechniquesHandler(new GrowthTechniqueLearningService(db)),
    new GenerateContentRecommendationsHandler(db, new ContentRecommendationEngine(db)),
  ];

  if (xPublishAdapter) {
    const scheduling = new SchedulingReadinessService(db);
    const publisher = new PublishApprovedContentService(db, xPublishAdapter, logger);
    handlers.push(new PublishDueContentHandler(db, scheduling, publisher));
  }

  return new AutomationScheduler(db, killSwitch, handlers, logger);
}

export interface RunContentAutomationJobOptions {
  maxItems?: number;
  resumeJobId?: string;
  forceDryRun?: boolean;
}

export async function resolveContentAutomationDryRun(config: SystemConfigService): Promise<boolean> {
  const mode = await config.getAutomationMode('content.publishing');
  return mode === 'dry_run';
}

export async function runContentAutomationJob(
  scheduler: AutomationScheduler,
  config: SystemConfigService,
  jobType: ContentAutomationJobType,
  options: RunContentAutomationJobOptions = {}
): Promise<RunScheduledJobResult> {
  const modeDryRun = await resolveContentAutomationDryRun(config);
  const maxItems = options.maxItems ?? (await config.getContentAutomationMaxItemsPerRun());
  const dryRun = modeDryRun || (options.forceDryRun ?? false);

  return scheduler.runScheduledJob(jobType, { dryRun, maxItems, resumeJobId: options.resumeJobId });
}
