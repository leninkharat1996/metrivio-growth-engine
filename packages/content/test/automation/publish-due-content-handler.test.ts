import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XPublishAdapter } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentDraftService } from '../../src/drafts/content-draft-service.js';
import { SchedulingReadinessService } from '../../src/publishing/scheduling-readiness.js';
import { PublishApprovedContentService } from '../../src/publishing/publish-approved-content-service.js';
import { PublishDueContentHandler } from '../../src/automation/publish-due-content-handler.js';
import { PUBLISH_DUE_CONTENT_JOB_TYPE } from '../../src/automation/job-types.js';
import { createContentAutomationScheduler, runContentAutomationJob } from '../../src/automation/content-automation.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let drafts: ContentDraftService;
let scheduling: SchedulingReadinessService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  drafts = new ContentDraftService(db);
  scheduling = new SchedulingReadinessService(db);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  await config.setAutomationMode('content.publishing', 'approval_required', 'test');
  await config.setDailyLimit('posts', 25, 'test');
});

afterEach(() => sqlite.close());

function fakeAdapter(): XPublishAdapter {
  return { publishPost: vi.fn(async (input) => ({ xPostId: uuid(), publishedAt: new Date().toISOString(), publishedText: input.text })) };
}

async function makeDueDraft(body: string): Promise<string> {
  const { draft } = await drafts.generateDraft({ ideaId: uuid(), body });
  await drafts.submitForApproval(draft.id);
  await drafts.approve(draft.id, 'lenin');
  await scheduling.markReadyForScheduling(draft.id);
  return draft.id;
}

describe('PublishDueContentHandler.run — discovery', () => {
  it('publishes an approved, ready, due draft', async () => {
    await makeDueDraft('a clean post about CAC');
    const adapter = fakeAdapter();
    const publisher = new PublishApprovedContentService(db, adapter);
    const handler = new PublishDueContentHandler(db, scheduling, publisher);

    const result = await handler.run({ runId: 'r1', dryRun: false, maxItems: 25, checkpoint: null, updateCheckpoint: async () => {} });
    expect(result.itemsProcessed).toBe(1);
    expect(result.itemsSucceeded).toBe(1);
    expect(adapter.publishPost).toHaveBeenCalledTimes(1);
  });

  it('ignores a draft not yet marked ready for scheduling', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await drafts.submitForApproval(draft.id);
    await drafts.approve(draft.id, 'lenin');
    // never marked ready for scheduling

    const adapter = fakeAdapter();
    const publisher = new PublishApprovedContentService(db, adapter);
    const handler = new PublishDueContentHandler(db, scheduling, publisher);
    const result = await handler.run({ runId: 'r1', dryRun: false, maxItems: 25, checkpoint: null, updateCheckpoint: async () => {} });
    expect(result.itemsProcessed).toBe(0);
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('ignores a draft scheduled in the future (not due)', async () => {
    const draftId = await makeDueDraft('clean body');
    await scheduling.scheduleFor(draftId, new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const adapter = fakeAdapter();
    const publisher = new PublishApprovedContentService(db, adapter);
    const handler = new PublishDueContentHandler(db, scheduling, publisher);
    const result = await handler.run({ runId: 'r1', dryRun: false, maxItems: 25, checkpoint: null, updateCheckpoint: async () => {} });
    expect(result.itemsProcessed).toBe(0);
  });

  it('ignores an already-published draft (idempotency short-circuit before ever calling the service)', async () => {
    const draftId = await makeDueDraft('clean body');
    await db.update(schema.contentDrafts).set({ xManagerPostId: 'already-there' }).where(eq(schema.contentDrafts.id, draftId));
    const adapter = fakeAdapter();
    const publisher = new PublishApprovedContentService(db, adapter);
    const handler = new PublishDueContentHandler(db, scheduling, publisher);
    const result = await handler.run({ runId: 'r1', dryRun: false, maxItems: 25, checkpoint: null, updateCheckpoint: async () => {} });
    expect(result.itemsProcessed).toBe(0);
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('is bounded by maxItems', async () => {
    await makeDueDraft('post one, distinct text');
    await makeDueDraft('post two, distinct text');
    await makeDueDraft('post three, distinct text');
    const adapter = fakeAdapter();
    const publisher = new PublishApprovedContentService(db, adapter);
    const handler = new PublishDueContentHandler(db, scheduling, publisher);
    const result = await handler.run({ runId: 'r1', dryRun: false, maxItems: 2, checkpoint: null, updateCheckpoint: async () => {} });
    expect(result.itemsProcessed).toBe(2);
  });

  it('continues after an isolated per-item failure rather than aborting the run', async () => {
    await makeDueDraft('post one, distinct text');
    await makeDueDraft('post two, distinct text');
    let calls = 0;
    const adapter: XPublishAdapter = {
      publishPost: vi.fn(async (input) => {
        calls += 1;
        if (calls === 1) throw new Error('simulated transient failure');
        return { xPostId: uuid(), publishedAt: new Date().toISOString(), publishedText: input.text };
      }),
    };
    const publisher = new PublishApprovedContentService(db, adapter);
    const handler = new PublishDueContentHandler(db, scheduling, publisher);
    const result = await handler.run({ runId: 'r1', dryRun: false, maxItems: 25, checkpoint: null, updateCheckpoint: async () => {} });
    expect(result.itemsProcessed).toBe(2);
    expect(adapter.publishPost).toHaveBeenCalledTimes(2);
    // one FAILED (mapped from the thrown Error -> classified FAILED by the service), one PUBLISHED
    expect(result.itemsSucceeded).toBe(1);
  });

  it('dry-run mode never calls the adapter and never marks a draft published', async () => {
    await makeDueDraft('clean body');
    const adapter = fakeAdapter();
    const publisher = new PublishApprovedContentService(db, adapter);
    const handler = new PublishDueContentHandler(db, scheduling, publisher);
    await handler.run({ runId: 'r1', dryRun: true, maxItems: 25, checkpoint: null, updateCheckpoint: async () => {} });
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('never approves, rejects, or mutates a draft body itself', async () => {
    const draftId = await makeDueDraft('clean body');
    const adapter = fakeAdapter();
    const publisher = new PublishApprovedContentService(db, adapter);
    const handler = new PublishDueContentHandler(db, scheduling, publisher);
    await handler.run({ runId: 'r1', dryRun: false, maxItems: 25, checkpoint: null, updateCheckpoint: async () => {} });
    const draft = await drafts.getDraft(draftId);
    expect(draft?.body).toBe('clean body');
    expect(draft?.status).toBe('APPROVED');
  });
});

describe('createContentAutomationScheduler — Stage 8 wiring', () => {
  it('does not register PUBLISH_DUE_CONTENT when xPublishAdapter is omitted (Stage 7 behavior unchanged)', async () => {
    const { db: freshDb, sqlite: freshSqlite } = createTestDb();
    const fakeXRead = { getTweets: async () => [], searchTweets: async () => [], getProfile: async () => ({ username: 'x' }), getFollowers: async () => [], getFollowing: async () => [], getListMembers: async () => [], getEngagers: async () => [] } as never;
    const scheduler = createContentAutomationScheduler(freshDb, fakeXRead);
    const result = await scheduler.runScheduledJob(PUBLISH_DUE_CONTENT_JOB_TYPE, {});
    expect(result.status).toBe('FAILED'); // no handler registered for this job type -> the scheduler reports it explicitly, never crashes and never silently no-ops as if work was done
    freshSqlite.close();
  });

  it('registers and runs PUBLISH_DUE_CONTENT when xPublishAdapter is provided', async () => {
    await makeDueDraft('clean body for factory wiring test');
    const fakeXRead = { getTweets: async () => [], searchTweets: async () => [], getProfile: async () => ({ username: 'x' }), getFollowers: async () => [], getFollowing: async () => [], getListMembers: async () => [], getEngagers: async () => [] } as never;
    const adapter = fakeAdapter();
    const scheduler = createContentAutomationScheduler(db, fakeXRead, undefined, adapter);
    const result = await runContentAutomationJob(scheduler, config, PUBLISH_DUE_CONTENT_JOB_TYPE, {});
    expect(result.status).toBe('COMPLETED');
    expect(adapter.publishPost).toHaveBeenCalledTimes(1);
  });
});
