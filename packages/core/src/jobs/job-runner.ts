import { and, eq, or } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { MetrivioDb } from '../db/client.js';
import { jobRuns } from '../db/schema.js';
import type { createLogger } from '../logging/logger.js';
import type { JobRunRecord, JobStatus } from './types.js';

function toRecord(row: typeof jobRuns.$inferSelect): JobRunRecord {
  return {
    id: row.id,
    jobType: row.jobType,
    status: row.status,
    checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) : null,
    attemptCount: row.attemptCount,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    errorDetail: row.errorDetail,
    createdAt: row.createdAt,
  };
}

/**
 * Implements "persistent job/run state so workflows can resume safely"
 * (Stage 1 requirement #10), following the same checkpoint-based resume
 * pattern RESEARCH.md §2 documents XActions itself using ("a checkpoint
 * written after every page means a scrape that dies at page 400 restarts
 * from its cursor, not from page one") — applied here at the level of
 * Metrivio's own pipeline jobs (discovery runs, enrichment batches, sequence
 * sends, etc.), not X-specific scraping.
 *
 * Every method is a plain async function over the `job_runs` table — no
 * in-memory state is kept, so a process restart loses nothing: the next
 * process to call `findResumable` picks up exactly where the last one left
 * its checkpoint.
 */
export class JobRunner {
  constructor(
    private readonly db: MetrivioDb,
    private readonly logger?: ReturnType<typeof createLogger>
  ) {}

  /** Starts a new job run and returns its id. */
  async start(jobType: string, initialCheckpoint: unknown = null): Promise<string> {
    const id = uuid();
    const now = new Date().toISOString();
    await this.db.insert(jobRuns).values({
      id,
      jobType,
      status: 'running',
      checkpoint: initialCheckpoint === null ? null : JSON.stringify(initialCheckpoint),
      attemptCount: 1,
      startedAt: now,
      lastHeartbeatAt: now,
      createdAt: now,
    });
    this.logger?.info({ jobId: id, jobType }, 'job.started');
    return id;
  }

  /**
   * Finds an existing job of this type left in `pending` or `running` state
   * from a previous, presumably-crashed process — the resume entry point.
   * Returns the most recently started one if more than one exists (there
   * shouldn't normally be more than one active run per job type, but this
   * doesn't assume that invariant is always upheld).
   */
  async findResumable(jobType: string): Promise<JobRunRecord | undefined> {
    const rows = await this.db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.jobType, jobType), or(eq(jobRuns.status, 'pending'), eq(jobRuns.status, 'running'))));
    if (rows.length === 0) return undefined;
    const mostRecent = rows.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
    return mostRecent ? toRecord(mostRecent) : undefined;
  }

  /** Records progress without ending the job — the checkpoint a resume would read. */
  async updateCheckpoint(jobId: string, checkpoint: unknown): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({ checkpoint: JSON.stringify(checkpoint), lastHeartbeatAt: new Date().toISOString() })
      .where(eq(jobRuns.id, jobId));
  }

  /** Marks a resumed run as running again and bumps its attempt count. */
  async markResumed(jobId: string): Promise<void> {
    const rows = await this.db.select().from(jobRuns).where(eq(jobRuns.id, jobId)).limit(1);
    const current = rows[0];
    await this.db
      .update(jobRuns)
      .set({
        status: 'running',
        attemptCount: (current?.attemptCount ?? 0) + 1,
        lastHeartbeatAt: new Date().toISOString(),
      })
      .where(eq(jobRuns.id, jobId));
    this.logger?.info({ jobId }, 'job.resumed');
  }

  async complete(jobId: string): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({ status: 'completed', completedAt: new Date().toISOString() })
      .where(eq(jobRuns.id, jobId));
    this.logger?.info({ jobId }, 'job.completed');
  }

  async fail(jobId: string, errorDetail: string): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({ status: 'failed', errorDetail, completedAt: new Date().toISOString() })
      .where(eq(jobRuns.id, jobId));
    this.logger?.error({ jobId, errorDetail }, 'job.failed');
  }

  async getStatus(jobId: string): Promise<JobStatus | undefined> {
    const rows = await this.db.select().from(jobRuns).where(eq(jobRuns.id, jobId)).limit(1);
    return rows[0]?.status;
  }

  async get(jobId: string): Promise<JobRunRecord | undefined> {
    const rows = await this.db.select().from(jobRuns).where(eq(jobRuns.id, jobId)).limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }
}
