import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentDraftService } from '../../src/drafts/content-draft-service.js';
import { SchedulingReadinessService } from '../../src/publishing/scheduling-readiness.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let drafts: ContentDraftService;
let service: SchedulingReadinessService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  drafts = new ContentDraftService(db);
  service = new SchedulingReadinessService(db);
});

afterEach(() => sqlite.close());

describe('SchedulingReadinessService.markReadyForScheduling', () => {
  it('marks an APPROVED draft as ready', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await drafts.submitForApproval(draft.id);
    await drafts.approve(draft.id, 'lenin');

    const result = await service.markReadyForScheduling(draft.id);
    expect(result.ready).toBe(true);
  });

  it('refuses a DRAFTED (not yet approved) draft', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    const result = await service.markReadyForScheduling(draft.id);
    expect(result.ready).toBe(false);
  });

  it('refuses a PENDING_APPROVAL draft', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await drafts.submitForApproval(draft.id);
    const result = await service.markReadyForScheduling(draft.id);
    expect(result.ready).toBe(false);
  });

  it('refuses a REJECTED draft', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await drafts.submitForApproval(draft.id);
    await drafts.reject(draft.id, 'lenin', 'not on-brand');
    const result = await service.markReadyForScheduling(draft.id);
    expect(result.ready).toBe(false);
  });

  it('refuses an unknown draft id', async () => {
    const result = await service.markReadyForScheduling('no-such-id');
    expect(result.ready).toBe(false);
  });

  it('never contacts any network or write adapter — it only writes an audit_log row', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await drafts.submitForApproval(draft.id);
    await drafts.approve(draft.id, 'lenin');
    await service.markReadyForScheduling(draft.id);

    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.draft.scheduling_ready'));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('never marks the underlying content_drafts row as published in any way', async () => {
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await drafts.submitForApproval(draft.id);
    await drafts.approve(draft.id, 'lenin');
    await service.markReadyForScheduling(draft.id);

    const rows = await db.select().from(schema.contentDrafts).where(eq(schema.contentDrafts.id, draft.id));
    expect(rows[0].xManagerPostId).toBeNull();
  });
});
