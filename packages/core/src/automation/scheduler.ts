import { KillSwitch } from '../kill-switch/kill-switch.js';
import { JobRunner } from '../jobs/job-runner.js';
import { writeAuditLog } from '../db/audit-log.js';
import type { MetrivioDb } from '../db/client.js';
import type { createLogger } from '../logging/logger.js';

/**
 * Stage 6E — a narrow, generic scheduler abstraction. It knows nothing about
 * X, outreach, prospects, or drafts: it only knows how to look up a
 * `JobHandler` by job type and run it once, safely, through the exact same
 * `KillSwitch`/`JobRunner`/`audit_log` primitives every other stage already
 * uses. This is deliberately NOT a queue, a cron daemon, or an arbitrary
 * execution engine — `runScheduledJob()` is a single explicit call that does
 * exactly one bounded unit of work for one job type, then returns. A future
 * job type (prospect enrichment, scoring, content review) plugs in by
 * implementing `JobHandler` — nothing here needs to change.
 *
 * Critically, this class never imports or references `XSendAdapter`,
 * `SendApprovedDraftService`, or any send-capable adapter — it has no way to
 * contact X at all. Whatever a `JobHandler` implementation chooses to do is
 * that handler's own responsibility; this file enforces none of that
 * business logic, only the run-level safety envelope (kill switch first,
 * one run per job type at a time, always audited, always resolves to one of
 * a small set of explicit outcomes).
 */

export const AUTOMATION_RUN_STATUSES = ['COMPLETED', 'PARTIAL', 'BLOCKED', 'DRY_RUN', 'FAILED'] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export interface JobHandlerContext {
  /** The underlying `job_runs.id` for this execution — handlers use this only to correlate their own audit_log rows, never to manage job_runs state themselves (the scheduler owns start/complete/fail). */
  runId: string;
  dryRun: boolean;
  /** A bound every handler must respect — see Section P (bounded work per run). */
  maxItems: number;
  /** The resumed job's last checkpoint, or `null` for a fresh run. Opaque to the scheduler; each handler defines its own checkpoint shape. */
  checkpoint: unknown;
  /** Persists progress so a crashed/interrupted run can resume without reprocessing completed items (Section G/F). */
  updateCheckpoint: (checkpoint: unknown) => Promise<void>;
}

export interface JobHandlerResult {
  itemsProcessed: number;
  itemsSucceeded: number;
  itemsFailed: number;
  /** Business-level detail (counts by outcome, etc.) — never credentials, never message content. */
  detail?: Record<string, unknown>;
}

export interface JobHandler {
  readonly jobType: string;
  run(ctx: JobHandlerContext): Promise<JobHandlerResult>;
}

export interface RunScheduledJobOptions {
  /** Default `false`. See each handler's own dry-run behavior — the scheduler itself only threads this flag through. */
  dryRun?: boolean;
  maxItems?: number;
  /** Resume a specific previously-started run of this job type rather than starting a new one. */
  resumeJobId?: string;
}

export interface RunScheduledJobResult {
  status: AutomationRunStatus;
  jobId?: string;
  reason: string;
  result?: JobHandlerResult;
}

const DEFAULT_MAX_ITEMS = 25;

export class AutomationScheduler {
  private readonly killSwitch: KillSwitch;
  private readonly jobRunner: JobRunner;
  private readonly handlers: Map<string, JobHandler>;

  constructor(
    private readonly db: MetrivioDb,
    killSwitch: KillSwitch,
    handlers: JobHandler[],
    private readonly logger?: ReturnType<typeof createLogger>
  ) {
    this.killSwitch = killSwitch;
    this.jobRunner = new JobRunner(db, logger);
    this.handlers = new Map(handlers.map((h) => [h.jobType, h]));
  }

  /**
   * Runs exactly one job type, exactly once, then returns. Never loops,
   * never schedules a next run, never calls another job type. Order of
   * checks (Section E/T): kill switch first (before anything else is even
   * considered, including whether another run is already in progress),
   * then the concurrency guard, then the handler itself.
   */
  async runScheduledJob(jobType: string, options: RunScheduledJobOptions = {}): Promise<RunScheduledJobResult> {
    if (await this.killSwitch.isActive()) {
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'automation.run.blocked',
        entityType: 'job_run',
        detail: { jobType, reason: 'kill switch active' },
      });
      // Never "no work due" — a kill-switch block is a distinct, unambiguous outcome (Section E).
      return { status: 'BLOCKED', reason: 'the kill switch is active — refusing to run any scheduled automation job' };
    }

    const handler = this.handlers.get(jobType);
    if (!handler) {
      return { status: 'FAILED', reason: `no job handler registered for job type "${jobType}"` };
    }

    const maxItems = options.maxItems && options.maxItems > 0 ? options.maxItems : DEFAULT_MAX_ITEMS;
    const dryRun = options.dryRun ?? false;

    let jobId: string;
    let checkpoint: unknown = null;

    if (options.resumeJobId) {
      const existing = await this.jobRunner.get(options.resumeJobId);
      if (!existing || existing.jobType !== jobType) {
        return { status: 'FAILED', reason: `cannot resume: no ${jobType} job_run found with id ${options.resumeJobId}` };
      }
      jobId = existing.id;
      checkpoint = existing.checkpoint;
      await this.jobRunner.markResumed(jobId);
    } else {
      // Concurrency guard (Section T): refuse to start a second concurrent
      // run of the SAME job type. A different job type is unaffected — this
      // is per-job-type, not a global lock, since JobRunner/job_runs itself
      // already scopes "resumable" lookups by job_type.
      const inProgress = await this.jobRunner.findResumable(jobType);
      if (inProgress) {
        return { status: 'BLOCKED', reason: `another run of job type "${jobType}" is already in progress (job_run ${inProgress.id})`, jobId: inProgress.id };
      }
      jobId = await this.jobRunner.start(jobType, null);
    }

    await writeAuditLog(this.db, {
      actor: 'system',
      actionType: 'automation.run.started',
      entityType: 'job_run',
      entityId: jobId,
      dryRun,
      detail: { jobType, maxItems, resumed: !!options.resumeJobId },
    });

    try {
      const result = await handler.run({
        runId: jobId,
        dryRun,
        maxItems,
        checkpoint,
        updateCheckpoint: (cp: unknown) => this.jobRunner.updateCheckpoint(jobId, cp),
      });
      await this.jobRunner.complete(jobId);

      const status: AutomationRunStatus = dryRun
        ? 'DRY_RUN'
        : result.itemsFailed > 0 && result.itemsSucceeded === 0 && result.itemsProcessed > 0
          ? 'FAILED'
          : result.itemsFailed > 0
            ? 'PARTIAL'
            : 'COMPLETED';

      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'automation.run.completed',
        entityType: 'job_run',
        entityId: jobId,
        dryRun,
        detail: { jobType, status, ...result },
      });

      this.logger?.info({ jobId, jobType, status, ...result }, 'automation.run.completed');
      return { status, jobId, reason: `job ${jobType} finished with status ${status}`, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.jobRunner.fail(jobId, message);
      await writeAuditLog(this.db, {
        actor: 'system',
        actionType: 'automation.run.failed',
        entityType: 'job_run',
        entityId: jobId,
        dryRun,
        detail: { jobType, error: message },
      });
      this.logger?.error({ jobId, jobType, error: message }, 'automation.run.failed');
      return { status: 'FAILED', jobId, reason: message };
    }
  }
}
