import { AutomationScheduler, KillSwitch, SystemConfigService, type MetrivioDb, type XReplyDetectorAdapter, type RunScheduledJobResult, type createLogger } from '@metrivio/core';
import { ReplyDetectionService } from '../follow-up/reply-detection-service.js';
import { FollowUpEligibilityService } from '../follow-up/follow-up-eligibility-service.js';
import { FollowUpDraftService } from '../follow-up/follow-up-draft-service.js';
import { DraftGenerationService } from '../drafts/draft-generation-service.js';
import { DueWorkDiscoveryService } from './due-work-discovery-service.js';
import { DiscoverDueFollowUpsHandler } from './discover-due-followups-handler.js';
import { RefreshReplyStateHandler } from './refresh-reply-state-handler.js';
import { PrepareFollowUpDraftsHandler } from './prepare-followup-drafts-handler.js';
import { DISCOVER_DUE_FOLLOWUPS_JOB_TYPE, REFRESH_REPLY_STATE_JOB_TYPE, PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE, type OutreachAutomationJobType } from './job-types.js';

/**
 * Stage 6E, Section N — the single explicit, callable entry point this
 * stage provides. No cron daemon, no background worker, no persistent
 * process: `createOutreachAutomationScheduler()` wires everything up, and
 * `runOutreachAutomationJob()` runs exactly one job type, exactly once, then
 * returns. An operator (or, later, an actual OS/cloud scheduler calling
 * this same function on an interval) decides when to call it — nothing in
 * this file decides that on its own.
 *
 * `replyDetector` is caller-supplied (Section: adapter injection, mirroring
 * every other Stage 6B/6C/6D service in this package) — this module never
 * constructs a concrete `XActionsReplyDetectorAdapter` itself, keeping
 * `packages/outreach` decoupled from `packages/adapters`.
 */
export function createOutreachAutomationScheduler(db: MetrivioDb, replyDetector: XReplyDetectorAdapter, logger?: ReturnType<typeof createLogger>): AutomationScheduler {
  const config = new SystemConfigService(db);
  const killSwitch = new KillSwitch(config);

  const replyDetectionService = new ReplyDetectionService(db, replyDetector, logger);
  const eligibilityService = new FollowUpEligibilityService(db, replyDetectionService);
  const draftGenerationService = new DraftGenerationService(db, logger);
  const followUpDraftService = new FollowUpDraftService(db, draftGenerationService, eligibilityService, logger);
  const discoveryService = new DueWorkDiscoveryService(db, eligibilityService);

  const handlers = [
    new DiscoverDueFollowUpsHandler(db, discoveryService),
    new RefreshReplyStateHandler(db, replyDetectionService),
    new PrepareFollowUpDraftsHandler(db, followUpDraftService, draftGenerationService.drafts, discoveryService),
  ];

  return new AutomationScheduler(db, killSwitch, handlers, logger);
}

export interface RunOutreachAutomationJobOptions {
  maxItems?: number;
  resumeJobId?: string;
  /** Overrides the automation-mode-derived dry-run default — for an operator who explicitly wants a dry-run preview regardless of configured mode. Never used to force a LIVE run when the configured mode is `dry_run` (see `resolveOutreachAutomationDryRun` below — the more conservative of the two always wins). */
  forceDryRun?: boolean;
}

/**
 * Resolves whether a run should be dry-run purely from the EXISTING
 * `prospecting.outreach.automation_mode` config (Stage 1) — no new
 * `automation.enabled`/`automation.mode` key is introduced (Section M).
 * `dry_run` (the fail-safe default when unset) means every job in this
 * stage runs in preview-only mode; `approval_required` and `autonomous`
 * both allow real `PENDING_APPROVAL` draft creation, since Stage 6E never
 * implements a send step under either mode (Section U) — "autonomous" is
 * simply not wired to anything here yet.
 */
export async function resolveOutreachAutomationDryRun(config: SystemConfigService): Promise<boolean> {
  const mode = await config.getAutomationMode('prospecting.outreach');
  return mode === 'dry_run';
}

export async function runOutreachAutomationJob(
  scheduler: AutomationScheduler,
  config: SystemConfigService,
  jobType: OutreachAutomationJobType,
  options: RunOutreachAutomationJobOptions = {}
): Promise<RunScheduledJobResult> {
  const modeDryRun = await resolveOutreachAutomationDryRun(config);
  const maxItems = options.maxItems ?? (await config.getOutreachAutomationMaxItemsPerRun());
  // The more conservative choice always wins: an explicit forceDryRun=true
  // can add caution on top of a live-configured mode, but a configured
  // dry_run mode can never be overridden into a live run from here.
  const dryRun = modeDryRun || (options.forceDryRun ?? false);

  return scheduler.runScheduledJob(jobType, { dryRun, maxItems, resumeJobId: options.resumeJobId });
}

export { DISCOVER_DUE_FOLLOWUPS_JOB_TYPE, REFRESH_REPLY_STATE_JOB_TYPE, PREPARE_FOLLOWUP_DRAFTS_JOB_TYPE };
