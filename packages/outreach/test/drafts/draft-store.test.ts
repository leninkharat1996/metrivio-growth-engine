import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { OutreachDraftService } from '../../src/drafts/draft-store.js';
import { InvalidDraftTransitionError } from '../../src/state-machine/draft-state-machine.js';
import type { EvidenceRowInput } from '../../src/personalization/personalization-candidates.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let service: OutreachDraftService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  service = new OutreachDraftService(db);
});

afterEach(() => sqlite.close());

function evidenceRow(overrides: Partial<EvidenceRowInput> = {}): EvidenceRowInput {
  return {
    id: 'e1',
    evidenceType: 'decision_maker_signal',
    signalCategory: 'role_founder_or_ceo',
    evidenceTier: 'CONFIRMED',
    rawValue: 'Founder',
    sourceUrl: null,
    ...overrides,
  };
}

describe('OutreachDraftService.generateDraft', () => {
  it('creates a new draft in state DRAFTED', async () => {
    const { draft, created } = await service.generateDraft({
      prospectId: 'p1',
      displayName: 'Jane Founder',
      companyName: 'Acme',
      evidenceRows: [evidenceRow()],
      painSignals: [],
      technologyDetections: [],
    });
    expect(created).toBe(true);
    expect(draft.status).toBe('DRAFTED');
    expect(draft.prospectId).toBe('p1');
    expect(draft.messageText.length).toBeGreaterThan(0);
    expect(draft.evidenceReferences).toContain('e1');
  });

  it('is idempotent — a second call for the same prospect while a draft is non-terminal returns the existing draft', async () => {
    const first = await service.generateDraft({ prospectId: 'p2', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    const second = await service.generateDraft({ prospectId: 'p2', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    expect(second.created).toBe(false);
    expect(second.draft.id).toBe(first.draft.id);
  });

  it('generates a new draft once the prior one reaches a terminal state', async () => {
    const first = await service.generateDraft({ prospectId: 'p3', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await service.reject(first.draft.id, 'reviewer-1', 'not a good fit right now');
    const second = await service.generateDraft({ prospectId: 'p3', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    expect(second.created).toBe(true);
    expect(second.draft.id).not.toBe(first.draft.id);
  });

  it('handles empty personalization safely — selectedHook is null, message text still generated', async () => {
    const { draft } = await service.generateDraft({ prospectId: 'p4', displayName: 'Jane', companyName: 'Acme', evidenceRows: [], painSignals: [], technologyDetections: [] });
    expect(draft.selectedHook).toBeNull();
    expect(draft.messageText.length).toBeGreaterThan(0);
    expect(draft.evidenceReferences).toEqual([]);
  });
});

describe('OutreachDraftService approval workflow', () => {
  it('DRAFTED -> PENDING_APPROVAL -> APPROVED, end to end', async () => {
    const { draft } = await service.generateDraft({ prospectId: 'p5', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    const submitted = await service.submitForApproval(draft.id);
    expect(submitted.status).toBe('PENDING_APPROVAL');
    const approved = await service.approve(draft.id, 'reviewer-1');
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe('reviewer-1');
  });

  it('PENDING_APPROVAL can be rejected, with a reason preserved', async () => {
    const { draft } = await service.generateDraft({ prospectId: 'p6', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await service.submitForApproval(draft.id);
    const rejected = await service.reject(draft.id, 'reviewer-1', 'message tone is off');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectedBy).toBe('reviewer-1');
    expect(rejected.rejectionReason).toBe('message tone is off');
  });

  it('rejects an invalid transition: DRAFTED -> APPROVED directly, without going through PENDING_APPROVAL', async () => {
    const { draft } = await service.generateDraft({ prospectId: 'p7', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await expect(service.approve(draft.id, 'reviewer-1')).rejects.toBeInstanceOf(InvalidDraftTransitionError);
  });

  it('approving an already-APPROVED draft twice is idempotent (no error, no duplicate audit rows)', async () => {
    const { draft } = await service.generateDraft({ prospectId: 'p8', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await service.submitForApproval(draft.id);
    const first = await service.approve(draft.id, 'reviewer-1');
    const second = await service.approve(draft.id, 'reviewer-2');
    expect(second.status).toBe('APPROVED');
    expect(second.approvedBy).toBe(first.approvedBy); // the second (no-op) call never overwrote who actually approved it

    const rows = await db.select().from(schema.auditLog);
    const approvalRows = rows.filter((r) => r.actionType === 'outreach.draft.approved');
    expect(approvalRows).toHaveLength(1);
  });

  it('rejecting a draft that does not exist throws', async () => {
    await expect(service.reject('no-such-draft', 'reviewer-1')).rejects.toThrow(/no draft found/);
  });

  it('approval is auditable via the existing audit_log table', async () => {
    const { draft } = await service.generateDraft({ prospectId: 'p9', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await service.submitForApproval(draft.id);
    await service.approve(draft.id, 'reviewer-1');

    const rows = await db.select().from(schema.auditLog);
    const draftEvents = rows.filter((r) => r.entityType === 'outreach_draft' && r.entityId === draft.id);
    expect(draftEvents.map((e) => e.actionType)).toEqual([
      'outreach.draft.created',
      'outreach.draft.submitted_for_approval',
      'outreach.draft.approved',
    ]);
    expect(draftEvents.every((e) => e.actor === 'system' || e.actor === 'human')).toBe(true);
  });

  it('no send operation exists anywhere on OutreachDraftService', () => {
    const methodNames = Object.getOwnPropertyNames(OutreachDraftService.prototype);
    expect(methodNames.some((name) => /send/i.test(name))).toBe(false);
  });
});

describe('OutreachDraftService.listDraftsForProspect', () => {
  it('finds drafts scoped to one prospect only', async () => {
    await service.generateDraft({ prospectId: 'p10', displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await service.generateDraft({ prospectId: 'p11', displayName: 'Bob', companyName: 'Other', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });

    const drafts = await service.listDraftsForProspect('p10');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].prospectId).toBe('p10');
  });

  it('returns an empty array for a prospect with no drafts', async () => {
    expect(await service.listDraftsForProspect('no-drafts-here')).toEqual([]);
  });
});

describe('OutreachDraftService.getDraft', () => {
  it('returns null for a draft id that does not exist', async () => {
    expect(await service.getDraft('no-such-draft')).toBeNull();
  });
});
