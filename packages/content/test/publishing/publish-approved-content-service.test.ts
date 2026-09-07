import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { schema, SystemConfigService, type MetrivioDb, type XPublishAdapter } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentDraftService } from '../../src/drafts/content-draft-service.js';
import { SchedulingReadinessService } from '../../src/publishing/scheduling-readiness.js';
import { PublishApprovedContentService } from '../../src/publishing/publish-approved-content-service.js';

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

function fakeAdapter(impl: (input: { text: string }) => Promise<{ xPostId: string; publishedAt: string; publishedText: string }>): XPublishAdapter {
  return { publishPost: vi.fn(impl) };
}

/** Fully walks a draft through DRAFTED -> PENDING_APPROVAL -> APPROVED -> ready-for-scheduling, and (optionally) due-now scheduling. */
async function approvedAndReadyDraft(body = 'a clean, original post about marketing efficiency'): Promise<string> {
  const { draft } = await drafts.generateDraft({ ideaId: uuid(), body });
  await drafts.submitForApproval(draft.id);
  await drafts.approve(draft.id, 'lenin');
  await scheduling.markReadyForScheduling(draft.id);
  return draft.id;
}

describe('PublishApprovedContentService.publishDraft — state/approval/scheduling preconditions', () => {
  it('BLOCKED when no such draft exists', async () => {
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft('nonexistent');
    expect(result.outcome).toBe('BLOCKED');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('BLOCKED for a DRAFTED (not yet approved) draft', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draft.id);
    expect(result.outcome).toBe('BLOCKED');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('BLOCKED for a REJECTED draft, even if somehow re-marked as due (never silently revived)', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await drafts.submitForApproval(draft.id);
    await drafts.reject(draft.id, 'lenin', 'not good enough');
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draft.id);
    expect(result.outcome).toBe('BLOCKED');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('BLOCKED for an APPROVED draft never marked ready for scheduling', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await drafts.submitForApproval(draft.id);
    await drafts.approve(draft.id, 'lenin');
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draft.id);
    expect(result.outcome).toBe('BLOCKED');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('BLOCKED when scheduledFor is in the future (not yet due)', async () => {
    const draftId = await approvedAndReadyDraft();
    await scheduling.scheduleFor(draftId, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('BLOCKED');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('publishes when scheduledFor is in the past (due)', async () => {
    const draftId = await approvedAndReadyDraft();
    await scheduling.scheduleFor(draftId, new Date(Date.now() - 60_000).toISOString());
    const adapter = fakeAdapter(async () => ({ xPostId: '999', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('PUBLISHED');
  });

  it('publishes an APPROVED, ready draft with no scheduledFor at all (manual "publish now")', async () => {
    const draftId = await approvedAndReadyDraft();
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('PUBLISHED');
  });
});

describe('PublishApprovedContentService.publishDraft — content-mutation invalidates approval (Section W)', () => {
  it('BLOCKED when the draft body changed after approval, without a fresh approve() call', async () => {
    const draftId = await approvedAndReadyDraft('original approved text');
    await drafts.updateBody(draftId, 'a completely different, unapproved text', 'someone');

    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reason).toMatch(/content changed after it was approved/);
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('publishes again once a mutated draft is re-approved, using the NEW text — approved text A never silently becomes published text B', async () => {
    const draftId = await approvedAndReadyDraft('original approved text');
    await drafts.updateBody(draftId, 'the new, re-approved text', 'someone');
    await drafts.approve(draftId, 'lenin'); // re-approval, covers the new body

    let publishedText: string | undefined;
    const adapter = fakeAdapter(async (input) => {
      publishedText = input.text;
      return { xPostId: '1', publishedAt: 't', publishedText: input.text };
    });
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('PUBLISHED');
    expect(publishedText).toBe('the new, re-approved text');
  });

  it('rescheduling (changing scheduledFor) alone does NOT invalidate approval — content and scheduling are independent axes (Section X)', async () => {
    const draftId = await approvedAndReadyDraft();
    await scheduling.scheduleFor(draftId, new Date(Date.now() - 60_000).toISOString());
    await scheduling.scheduleFor(draftId, new Date(Date.now() - 30_000).toISOString()); // reschedule, same content

    const integrity = await drafts.getApprovalIntegrity(draftId);
    expect(integrity.contentChangedSinceApproval).toBe(false);

    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('PUBLISHED');
  });
});

describe('PublishApprovedContentService.publishDraft — content revalidation (Section G)', () => {
  it('BLOCKED when the body now fails Stage 7 validation (e.g. a fabricated case-study claim)', async () => {
    const draftId = await approvedAndReadyDraft('we achieved amazing results for our client');
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('BLOCKED');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('BLOCKED when the body exceeds the verified X length limit', async () => {
    const draftId = await approvedAndReadyDraft('x'.repeat(281));
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reason).toMatch(/length limit/);
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });
});

describe('PublishApprovedContentService.publishDraft — idempotency (Section L)', () => {
  it('is a no-op returning PUBLISHED with the existing post ID when x_manager_post_id is already set', async () => {
    const draftId = await approvedAndReadyDraft();
    await db.update(schema.contentDrafts).set({ xManagerPostId: 'already-published-id' }).where(eq(schema.contentDrafts.id, draftId));

    const adapter = fakeAdapter(async () => ({ xPostId: 'should-never-be-called', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('PUBLISHED');
    expect(result.xPostId).toBe('already-published-id');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('calling publishDraft twice for the same draft only calls the adapter once', async () => {
    const draftId = await approvedAndReadyDraft();
    const adapter = fakeAdapter(async () => ({ xPostId: 'post-1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const first = await service.publishDraft(draftId);
    const second = await service.publishDraft(draftId);
    expect(first.outcome).toBe('PUBLISHED');
    expect(second.outcome).toBe('PUBLISHED');
    expect(second.xPostId).toBe('post-1');
    expect(adapter.publishPost).toHaveBeenCalledTimes(1);
  });
});

describe('PublishApprovedContentService.publishDraft — kill switch (Section I)', () => {
  it('BLOCKED, and the adapter is never called, when the kill switch is active', async () => {
    await config.setKillSwitch(true, 'test');
    const draftId = await approvedAndReadyDraft();
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('BLOCKED');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });
});

describe('PublishApprovedContentService.publishDraft — publishing mode (Section J)', () => {
  it('never calls the adapter in dry_run mode, and reports it clearly', async () => {
    await config.setAutomationMode('content.publishing', 'dry_run', 'test');
    const draftId = await approvedAndReadyDraft();
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reason).toMatch(/DRY_RUN/);
    expect(result.dryRun).toBe(true);
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('never alters draft state in dry_run mode', async () => {
    await config.setAutomationMode('content.publishing', 'dry_run', 'test');
    const draftId = await approvedAndReadyDraft();
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    await service.publishDraft(draftId);
    const row = (await db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.id, draftId)))[0];
    expect(row.xManagerPostId).toBeNull();
  });

  it('publishes in approval_required mode (the default) since the draft is already human-approved', async () => {
    const draftId = await approvedAndReadyDraft();
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('PUBLISHED');
  });

  it('BLOCKED in autonomous mode when content.publishing.autonomous_enabled is not explicitly set (fail closed)', async () => {
    await config.setAutomationMode('content.publishing', 'autonomous', 'test');
    const draftId = await approvedAndReadyDraft();
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('BLOCKED');
    expect(adapter.publishPost).not.toHaveBeenCalled();
  });

  it('publishes in autonomous mode once content.publishing.autonomous_enabled is explicitly true', async () => {
    await config.setAutomationMode('content.publishing', 'autonomous', 'test');
    await config.setContentPublishingAutonomousEnabled(true, 'test');
    const draftId = await approvedAndReadyDraft();
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('PUBLISHED');
  });
});

describe('PublishApprovedContentService.publishDraft — limits (Section K)', () => {
  it('BLOCKED once the daily post limit is reached', async () => {
    await config.setDailyLimit('posts', 1, 'test');
    const draftId1 = await approvedAndReadyDraft('first post body');
    const draftId2 = await approvedAndReadyDraft('second, different post body');

    const adapter = fakeAdapter(async () => ({ xPostId: uuid(), publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    const first = await service.publishDraft(draftId1);
    const second = await service.publishDraft(draftId2);
    expect(first.outcome).toBe('PUBLISHED');
    expect(second.outcome).toBe('BLOCKED');
    expect(second.reason).toMatch(/daily post limit/);
  });
});

describe('PublishApprovedContentService.publishDraft — error mapping / unknown outcomes (Section M)', () => {
  it('maps an XPublishNetworkError to UNKNOWN, never FAILED or PUBLISHED', async () => {
    const draftId = await approvedAndReadyDraft();
    const adapter: XPublishAdapter = {
      publishPost: vi.fn(async () => {
        const { XPublishNetworkError } = await import('@metrivio/core');
        throw new XPublishNetworkError('FakeAdapter', 'publishPost', 'connection reset');
      }),
    };
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('UNKNOWN');
  });

  it('maps an XPublishAuthenticationRequiredError to FAILED (a definitive rejection)', async () => {
    const draftId = await approvedAndReadyDraft();
    const adapter: XPublishAdapter = {
      publishPost: vi.fn(async () => {
        const { XPublishAuthenticationRequiredError } = await import('@metrivio/core');
        throw new XPublishAuthenticationRequiredError('FakeAdapter', 'publishPost');
      }),
    };
    const service = new PublishApprovedContentService(db, adapter);
    const result = await service.publishDraft(draftId);
    expect(result.outcome).toBe('FAILED');
  });

  it('never marks the draft published on FAILED or UNKNOWN outcomes', async () => {
    const draftId = await approvedAndReadyDraft();
    const adapter: XPublishAdapter = {
      publishPost: vi.fn(async () => {
        const { XPublishRateLimitedError } = await import('@metrivio/core');
        throw new XPublishRateLimitedError('FakeAdapter', 'publishPost');
      }),
    };
    const service = new PublishApprovedContentService(db, adapter);
    await service.publishDraft(draftId);
    const row = (await db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.id, draftId)))[0];
    expect(row.xManagerPostId).toBeNull();
  });
});

describe('PublishApprovedContentService.publishDraft — own-content ingestion + audit (Sections Q/S)', () => {
  it('ingests a real own-content-performance snapshot with the actual returned post ID/text, never fabricated metrics', async () => {
    const draftId = await approvedAndReadyDraft('a post about CAC efficiency');
    const adapter = fakeAdapter(async (input) => ({ xPostId: 'real-post-id', publishedAt: 't', publishedText: input.text }));
    const service = new PublishApprovedContentService(db, adapter);
    await service.publishDraft(draftId);

    const perfRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.performance.ingested'));
    expect(perfRows.length).toBe(1);
    const detail = JSON.parse(perfRows[0].detail!);
    expect(detail.postId).toBe('real-post-id');
  });

  it('writes an audit row for every outcome, including BLOCKED, containing no secrets', async () => {
    const draftId = await approvedAndReadyDraft();
    await config.setKillSwitch(true, 'test');
    const adapter = fakeAdapter(async () => ({ xPostId: '1', publishedAt: 't', publishedText: 'x' }));
    const service = new PublishApprovedContentService(db, adapter);
    await service.publishDraft(draftId);

    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.publish.blocked'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.detail ?? '').not.toMatch(/token|cookie|secret|password/i);
    }
  });
});
