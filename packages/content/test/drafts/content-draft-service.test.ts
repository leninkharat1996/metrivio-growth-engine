import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentDraftService } from '../../src/drafts/content-draft-service.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let service: ContentDraftService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  service = new ContentDraftService(db);
});

afterEach(() => sqlite.close());

describe('ContentDraftService.generateDraft — opportunity to draft', () => {
  it('creates a draft in DRAFTED status', async () => {
    const { draft, created } = await service.generateDraft({ ideaId: uuid(), body: 'Why ROAS can mislead you as you scale.' });
    expect(created).toBe(true);
    expect(draft.status).toBe('DRAFTED');
  });

  it('is idempotent — a second call for the same idea reuses the non-terminal draft', async () => {
    const ideaId = uuid();
    const first = await service.generateDraft({ ideaId, body: 'first body' });
    const second = await service.generateDraft({ ideaId, body: 'second body' });
    expect(second.created).toBe(false);
    expect(second.draft.id).toBe(first.draft.id);
  });

  it('preserves hookVariants and chosenHook', async () => {
    const { draft } = await service.generateDraft({ ideaId: uuid(), body: 'body text', hookVariants: { a: 'A', b: 'B', c: 'C' }, chosenHook: 'A' });
    expect(draft.hookVariants).toEqual({ a: 'A', b: 'B', c: 'C' });
    expect(draft.chosenHook).toBe('A');
  });
});

describe('ContentDraftService — fabrication/unsupported-claim rejection', () => {
  it('flags a draft containing a fabricated metric', async () => {
    const { draft } = await service.generateDraft({ ideaId: uuid(), body: 'We generated $50,000 in savings for our client.' });
    expect(draft.qualityCheckStatus).toBe('flagged');
    expect(draft.qualityCheckNotes.length).toBeGreaterThan(0);
  });

  it('passes a clean draft with no fabricated claims', async () => {
    const { draft } = await service.generateDraft({ ideaId: uuid(), body: 'A diagnostic framework for thinking about blended ROAS.' });
    expect(draft.qualityCheckStatus).toBe('pass');
  });
});

describe('ContentDraftService — approval boundary (Section W)', () => {
  it('goes DRAFTED -> PENDING_APPROVAL -> APPROVED', async () => {
    const { draft } = await service.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await service.submitForApproval(draft.id);
    const pending = await service.getDraft(draft.id);
    expect(pending?.status).toBe('PENDING_APPROVAL');

    await service.approve(draft.id, 'lenin');
    const approved = await service.getDraft(draft.id);
    expect(approved?.status).toBe('APPROVED');
    expect(approved?.approvedBy).toBe('lenin');
  });

  it('a REJECT from PENDING_APPROVAL is terminal, with a preserved reason', async () => {
    const { draft } = await service.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await service.submitForApproval(draft.id);
    await service.reject(draft.id, 'lenin', 'not on-brand');

    const rejected = await service.getDraft(draft.id);
    expect(rejected?.status).toBe('REJECTED');
    expect(rejected?.rejectedBy).toBe('lenin');
    expect(rejected?.rejectionReason).toBe('not on-brand');
  });

  it('automation never manufactures approval — approve() always requires an explicit approver id', async () => {
    const { draft } = await service.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await service.submitForApproval(draft.id);
    await service.approve(draft.id, 'human-reviewer-1');
    const approved = await service.getDraft(draft.id);
    expect(approved?.approvedBy).toBe('human-reviewer-1');
  });

  it('rejects skipping PENDING_APPROVAL to reach APPROVED directly', async () => {
    const { draft } = await service.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await expect(service.approve(draft.id, 'lenin')).rejects.toThrow();
  });

  it('an approved draft stays approved — repeated approve() is idempotent', async () => {
    const { draft } = await service.generateDraft({ ideaId: uuid(), body: 'clean body' });
    await service.submitForApproval(draft.id);
    await service.approve(draft.id, 'lenin');
    const again = await service.approve(draft.id, 'someone-else');
    expect(again.approvedBy).toBe('lenin'); // unchanged — idempotent no-op, not a re-approval
  });
});
