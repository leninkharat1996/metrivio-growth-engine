import { AutomationScheduler, KillSwitch, SystemConfigService, type MetrivioDb, type XReadAdapter, type RunScheduledJobResult, type createLogger } from '@metrivio/core';
import { IcpResearchService } from '../icp-research/icp-research-service.js';
import { TrackedAccountStore } from '../accounts/tracked-account-store.js';
import { TrackedAccountResearchService } from '../accounts/tracked-account-research-service.js';
import { ContentSignalStore } from '../signals/content-signal-store.js';
import { ContentOpportunityEngine } from '../opportunities/content-opportunity-engine.js';
import { ContentDraftService } from '../drafts/content-draft-service.js';
import { OwnContentPerformanceService } from '../own-content/own-content-performance-service.js';
import { PersonalBrandAnalysisService } from '../personal-brand/personal-brand-analysis-service.js';
import { IngestContentSignalsHandler } from './ingest-content-signals-handler.js';
import { AnalyzeIcpConversationsHandler } from './analyze-icp-conversations-handler.js';
import { AnalyzeCompetitorContentHandler } from './analyze-competitor-content-handler.js';
import { AnalyzeExpertContentHandler } from './analyze-expert-content-handler.js';
import { GenerateContentOpportunitiesHandler } from './generate-content-opportunities-handler.js';
import { GenerateContentDraftsHandler } from './generate-content-drafts-handler.js';
import { ValidateContentDraftsHandler } from './validate-content-drafts-handler.js';
import { AnalyzeOwnContentHandler } from './analyze-own-content-handler.js';
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
 */
export function createContentAutomationScheduler(db: MetrivioDb, xReadAdapter: XReadAdapter, logger?: ReturnType<typeof createLogger>): AutomationScheduler {
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

  const handlers = [
    new IngestContentSignalsHandler(db, icpResearch),
    new AnalyzeIcpConversationsHandler(db, signals),
    new AnalyzeCompetitorContentHandler(db, accounts, accountResearch),
    new AnalyzeExpertContentHandler(db, accounts, accountResearch, personalBrand),
    new GenerateContentOpportunitiesHandler(opportunityEngine),
    new GenerateContentDraftsHandler(db, drafts),
    new ValidateContentDraftsHandler(db, drafts),
    new AnalyzeOwnContentHandler(performance),
  ];

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
