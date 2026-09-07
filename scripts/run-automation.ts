import {
  createDbClient,
  createLogger,
  KillSwitch,
  loadEnv,
  resetEnvCache,
  SystemConfigService,
} from '@metrivio/core';
import { XActionsReadAdapter, XActionsReplyDetectorAdapter } from '@metrivio/adapters';
import { createContentAutomationScheduler, runContentAutomationJob } from '@metrivio/content';
import { createOutreachAutomationScheduler, runOutreachAutomationJob } from '@metrivio/outreach';

const CONTENT_JOBS = new Set([
  'ingest_content_signals',
  'analyze_icp_conversations',
  'analyze_competitor_content',
  'analyze_expert_content',
  'generate_content_opportunities',
  'generate_content_drafts',
  'validate_content_drafts',
  'analyze_own_content',
  'collect_post_performance',
  'analyze_content_performance',
  'update_growth_techniques',
  'generate_content_recommendations',
]);

const OUTREACH_JOBS = new Set([
  'discover_due_followups',
  'refresh_reply_state',
  'prepare_followup_drafts',
]);

async function main(): Promise<void> {
  resetEnvCache();
  const env = loadEnv();
  const { db, sqlite } = createDbClient({ path: env.DATABASE_PATH });
  const logger = createLogger({ name: 'metrivio-automation' });
  const config = new SystemConfigService(db);

  await config.seedDefaultsFromEnv(env);
  const killSwitch = new KillSwitch(config);
  await killSwitch.assertNotActive('automation.runner');

  const jobs = (process.env.METRIVIO_JOBS ?? [
    'ingest_content_signals',
    'analyze_competitor_content',
    'analyze_expert_content',
    'generate_content_opportunities',
    'generate_content_recommendations',
  ].join(','))
    .split(',')
    .map((job) => job.trim())
    .filter(Boolean);

  const maxItems = Number.parseInt(process.env.METRIVIO_MAX_ITEMS ?? '10', 10);
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error('METRIVIO_MAX_ITEMS must be a positive integer');
  }

  const sessionCookie = process.env.XACTIONS_SESSION_COOKIE || undefined;
  const xReadAdapter = new XActionsReadAdapter({ killSwitch, sessionCookie });
  const contentScheduler = createContentAutomationScheduler(db, xReadAdapter, logger);
  const replyDetector = new XActionsReplyDetectorAdapter({ killSwitch, sessionCookie });
  const outreachScheduler = createOutreachAutomationScheduler(db, replyDetector, logger);

  const results: Array<{
    job: string;
    status: string;
    reason: string;
    itemsProcessed?: number;
    itemsSucceeded?: number;
    itemsFailed?: number;
    detail?: Record<string, unknown>;
  }> = [];

  for (const job of jobs) {
    if (CONTENT_JOBS.has(job)) {
      const result = await runContentAutomationJob(
        contentScheduler,
        config,
        job as Parameters<typeof runContentAutomationJob>[2],
        { maxItems, forceDryRun: false },
      );
      results.push({
        job,
        status: result.status,
        reason: result.reason,
        itemsProcessed: result.result?.itemsProcessed,
        itemsSucceeded: result.result?.itemsSucceeded,
        itemsFailed: result.result?.itemsFailed,
        detail: result.result?.detail,
      });
      continue;
    }

    if (OUTREACH_JOBS.has(job)) {
      const result = await runOutreachAutomationJob(
        outreachScheduler,
        config,
        job as Parameters<typeof runOutreachAutomationJob>[2],
        { maxItems, forceDryRun: true },
      );
      results.push({
        job,
        status: result.status,
        reason: result.reason,
        itemsProcessed: result.result?.itemsProcessed,
        itemsSucceeded: result.result?.itemsSucceeded,
        itemsFailed: result.result?.itemsFailed,
        detail: result.result?.detail,
      });
      continue;
    }

    throw new Error(`Unsupported automation job: ${job}`);
  }

  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  sqlite.close();

  console.log(JSON.stringify({ ok: true, jobs: results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
