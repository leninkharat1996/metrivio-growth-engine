import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobRunner } from '../src/jobs/job-runner.js';
import { createTestDb } from './helpers/test-db.js';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '../src/db/client.js';

describe('JobRunner: persistent job/run state and safe resume', () => {
  let db: MetrivioDb;
  let sqlite: Database.Database;
  let runner: JobRunner;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    runner = new JobRunner(db);
  });

  afterEach(() => sqlite.close());

  it('starts a job and persists its initial checkpoint', async () => {
    const jobId = await runner.start('discovery.keyword_search', { cursor: null, processed: 0 });
    const record = await runner.get(jobId);
    expect(record?.status).toBe('running');
    expect(record?.checkpoint).toEqual({ cursor: null, processed: 0 });
    expect(record?.attemptCount).toBe(1);
  });

  it('updates the checkpoint as work progresses, without ending the job', async () => {
    const jobId = await runner.start('discovery.keyword_search', { processed: 0 });
    await runner.updateCheckpoint(jobId, { processed: 50, cursor: 'page-2' });
    const record = await runner.get(jobId);
    expect(record?.status).toBe('running');
    expect(record?.checkpoint).toEqual({ processed: 50, cursor: 'page-2' });
  });

  it('marks a job completed and it is no longer resumable', async () => {
    const jobId = await runner.start('discovery.keyword_search');
    await runner.complete(jobId);
    expect(await runner.getStatus(jobId)).toBe('completed');
    expect(await runner.findResumable('discovery.keyword_search')).toBeUndefined();
  });

  it('marks a job failed and records the error detail', async () => {
    const jobId = await runner.start('enrichment.batch');
    await runner.fail(jobId, 'network timeout');
    const record = await runner.get(jobId);
    expect(record?.status).toBe('failed');
    expect(record?.errorDetail).toBe('network timeout');
  });

  it('findResumable finds a job left running from a prior (simulated crashed) process', async () => {
    const jobId = await runner.start('enrichment.batch', { processed: 30 });
    // Simulate a fresh process by constructing a new JobRunner instance over
    // the same database, exactly as a restart would.
    const freshRunner = new JobRunner(db);
    const resumable = await freshRunner.findResumable('enrichment.batch');
    expect(resumable?.id).toBe(jobId);
    expect(resumable?.checkpoint).toEqual({ processed: 30 });
  });

  it('resuming bumps the attempt count and keeps the job running', async () => {
    const jobId = await runner.start('enrichment.batch', { processed: 30 });
    const before = await runner.get(jobId);
    await runner.markResumed(jobId);
    const after = await runner.get(jobId);
    expect(after?.attemptCount).toBe((before?.attemptCount ?? 0) + 1);
    expect(after?.status).toBe('running');
  });

  it('a completed job is never returned by findResumable, even if another job of the same type is running', async () => {
    const completedId = await runner.start('discovery.keyword_search', { done: true });
    await runner.complete(completedId);
    const runningId = await runner.start('discovery.keyword_search', { done: false });

    const resumable = await runner.findResumable('discovery.keyword_search');
    expect(resumable?.id).toBe(runningId);
    expect(resumable?.id).not.toBe(completedId);
  });

  it('checkpoint round-trips arbitrary JSON-serializable shapes', async () => {
    const complexCheckpoint = { cursor: 'abc', seen: ['a', 'b', 'c'], meta: { retries: 2, ok: true } };
    const jobId = await runner.start('enrichment.batch', complexCheckpoint);
    const record = await runner.get(jobId);
    expect(record?.checkpoint).toEqual(complexCheckpoint);
  });
});
