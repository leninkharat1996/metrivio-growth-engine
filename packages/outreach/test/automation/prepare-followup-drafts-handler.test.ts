import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReplyDetectorAdapter, type ConversationMessageObservation } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ReplyDetectionService } from '../../src/follow-up/reply-detection-service.js';
import { FollowUpEligibilityService } from '../../src/follow-up/follow-up-eligibility-service.js';
import { FollowUpDraftService } from '../../src/follow-up/follow-up-draft-service.js';
import { DraftGenerationService } from '../../src/drafts/draft-generation-service.js';
import { DueWorkDiscoveryService } from '../../src/automation/due-work-discovery-service.js';
import { PrepareFollowUpDraftsHandler } from '../../src/automation/prepare-followup-drafts-handler.js';

class ScriptedReplyDetector implements XReplyDetectorAdapter {
  private queue: Array<ConversationMessageObservation[] | Error> = [];
  queueMessages(messages: ConversationMessageObservation[]): void {
    this.queue.push(messages);
  }
  async getConversationMessages(): Promise<ConversationMessageObservation[]> {
    const next = this.queue.shift();
    if (next === undefined) return [];
    if (next instanceof Error) throw next;
    return next;
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let detector: ScriptedReplyDetector;
let draftGeneration: DraftGenerationService;
let handler: PrepareFollowUpDraftsHandler;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  detector = new ScriptedReplyDetector();
  const replyDetection = new ReplyDetectionService(db, detector);
  const eligibilityService = new FollowUpEligibilityService(db, replyDetection);
  draftGeneration = new DraftGenerationService(db);
  const followUpDraftService = new FollowUpDraftService(db, draftGeneration, eligibilityService);
  const discovery = new DueWorkDiscoveryService(db, eligibilityService);
  handler = new PrepareFollowUpDraftsHandler(db, followUpDraftService, draftGeneration.drafts, discovery);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  await config.setDailyLimit('dms', 10, 'test');
});

afterEach(() => sqlite.close());

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({
    id,
    xUsername: `user-${id.slice(0, 8)}`,
    xUserId: `xid-${id.slice(0, 8)}`,
    displayName: 'Jane Founder',
    companyName: 'Acme',
    source: 'founder_search',
    dateDiscovered: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function insertSequence(steps: Array<{ step_order: number; day_offset: number }>): Promise<string> {
  const id = uuid();
  await db.insert(schema.sequences).values({ id, name: 'test-sequence', steps: JSON.stringify(steps) });
  return id;
}

async function insertEvidence(prospectId: string): Promise<void> {
  await db.insert(schema.evidence).values({
    id: uuid(),
    prospectId,
    evidenceType: 'decision_maker_signal',
    signalCategory: 'role_founder_or_ceo',
    evidenceTier: 'CONFIRMED',
    rawValue: 'Founder',
    sourceUrl: null,
  });
}

/** Mirrors follow-up-draft-service.test.ts's helper — sends an original approved draft via the real send boundary, then re-points its outreach_messages row onto our real test sequence/step 1. */
async function sendOriginalMessage(prospectId: string, sequenceId: string): Promise<void> {
  const { draft } = await draftGeneration.generateDraftForProspect(prospectId);
  await draftGeneration.drafts.submitForApproval(draft.id);
  await draftGeneration.drafts.approve(draft.id, 'reviewer-1');

  await db.insert(schema.outreachMessages).values({
    id: uuid(),
    prospectId,
    sequenceId,
    sequenceStepOrder: 1,
    personalizationBasis: JSON.stringify({ draftId: draft.id, evidenceReferences: draft.evidenceReferences }),
    messageContent: draft.messageText,
    channel: 'dm',
    status: 'sent',
    sentAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

function ctx(overrides: Partial<{ dryRun: boolean; maxItems: number }> = {}) {
  return { runId: 'run-1', dryRun: overrides.dryRun ?? false, maxItems: overrides.maxItems ?? 25, checkpoint: null, updateCheckpoint: async () => undefined };
}

/** `listDraftsForProspect` returns every draft ever created for the prospect, including the original (non-follow-up) draft `dueSequenceFor` creates and approves — tests care specifically about the follow-up draft, identified by carrying a `sequenceId`. */
async function followUpDraftsFor(prospectId: string) {
  const all = await draftGeneration.drafts.listDraftsForProspect(prospectId);
  return all.filter((d) => d.sequenceId !== undefined);
}

async function dueSequenceFor(prospectId: string): Promise<string> {
  const sequenceId = await insertSequence([
    { step_order: 1, day_offset: 0 },
    { step_order: 2, day_offset: 1 },
  ]);
  await insertEvidence(prospectId);
  await sendOriginalMessage(prospectId, sequenceId);
  return sequenceId;
}

describe('PrepareFollowUpDraftsHandler — approval boundary (Section K)', () => {
  it('an eligible candidate produces a draft in PENDING_APPROVAL, never APPROVED', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await dueSequenceFor(prospectId);
    detector.queueMessages([]);

    await handler.run(ctx());

    const drafts = await followUpDraftsFor(prospectId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('PENDING_APPROVAL');
    void sequenceId;
  });

  it('automation never calls approve() — an approved draft can only exist if a human approved it', async () => {
    const prospectId = await insertProspect();
    await dueSequenceFor(prospectId);
    detector.queueMessages([]);
    await handler.run(ctx());

    const drafts = await followUpDraftsFor(prospectId);
    expect(drafts[0].approvedBy).toBeUndefined();
  });
});

describe('PrepareFollowUpDraftsHandler — idempotency (Section G)', () => {
  it('does not create a duplicate draft on a second run', async () => {
    const prospectId = await insertProspect();
    await dueSequenceFor(prospectId);
    detector.queueMessages([]);
    await handler.run(ctx());

    detector.queueMessages([]);
    await handler.run(ctx());

    const drafts = await followUpDraftsFor(prospectId);
    expect(drafts).toHaveLength(1);
  });

  it('does not reset approval — an already-approved draft stays approved across a repeated run', async () => {
    const prospectId = await insertProspect();
    await dueSequenceFor(prospectId);
    detector.queueMessages([]);
    await handler.run(ctx());

    const drafts = await followUpDraftsFor(prospectId);
    await draftGeneration.drafts.approve(drafts[0].id, 'reviewer-2');

    detector.queueMessages([]);
    const result = await handler.run(ctx());

    const after = await draftGeneration.drafts.getDraft(drafts[0].id);
    expect(after?.status).toBe('APPROVED');
    expect(after?.approvedBy).toBe('reviewer-2');
    expect(result.itemsFailed).toBe(0); // the guard must skip re-submitting cleanly, never throw
  });

  it('a rejected draft remains rejected across a repeated run', async () => {
    const prospectId = await insertProspect();
    await dueSequenceFor(prospectId);
    detector.queueMessages([]);
    await handler.run(ctx());

    const drafts = await followUpDraftsFor(prospectId);
    await draftGeneration.drafts.reject(drafts[0].id, 'reviewer-2', 'not a fit');

    detector.queueMessages([]);
    const result = await handler.run(ctx());

    const after = await draftGeneration.drafts.getDraft(drafts[0].id);
    expect(after?.status).toBe('REJECTED');
    expect(result.itemsFailed).toBe(0);
  });

  it('reuses the existing PENDING_APPROVAL draft rather than creating a second one when run a third time', async () => {
    const prospectId = await insertProspect();
    await dueSequenceFor(prospectId);
    detector.queueMessages([]);
    await handler.run(ctx());
    detector.queueMessages([]);
    await handler.run(ctx());
    detector.queueMessages([]);
    await handler.run(ctx());

    const drafts = await followUpDraftsFor(prospectId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('PENDING_APPROVAL');
  });
});

describe('PrepareFollowUpDraftsHandler — dry-run (Section D)', () => {
  it('identifies what would happen without creating any draft', async () => {
    const prospectId = await insertProspect();
    await dueSequenceFor(prospectId);
    detector.queueMessages([]);

    const result = await handler.run(ctx({ dryRun: true }));
    expect(result.detail?.wouldCreateDraftCount).toBe(1);

    const drafts = await followUpDraftsFor(prospectId);
    expect(drafts).toHaveLength(0);
  });

  it('never writes an outreach_messages row or advances approval state during dry-run', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await dueSequenceFor(prospectId);
    detector.queueMessages([]);
    await handler.run(ctx({ dryRun: true }));

    const messages = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.sequenceStepOrder, 2));
    expect(messages).toHaveLength(0);
    void sequenceId;
  });
});

describe('PrepareFollowUpDraftsHandler — critical eligibility gates', () => {
  it('does not draft for a REPLIED prospect', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    await dueSequenceFor(prospectId);
    detector.queueMessages([{ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'hey', createdAt: new Date().toISOString() }]);

    await handler.run(ctx());
    const drafts = await followUpDraftsFor(prospectId);
    expect(drafts).toHaveLength(0);
  });

  it('does not draft for a NOT_DUE follow-up', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 90 },
    ]);
    await insertEvidence(prospectId);
    const { draft } = await draftGeneration.generateDraftForProspect(prospectId);
    await draftGeneration.drafts.submitForApproval(draft.id);
    await draftGeneration.drafts.approve(draft.id, 'reviewer-1');
    await db.insert(schema.outreachMessages).values({
      id: uuid(),
      prospectId,
      sequenceId,
      sequenceStepOrder: 1,
      personalizationBasis: JSON.stringify({ draftId: draft.id, evidenceReferences: draft.evidenceReferences }),
      messageContent: draft.messageText,
      channel: 'dm',
      status: 'sent',
      sentAt: new Date().toISOString(), // just sent — not due for 90 days
    });

    await handler.run(ctx());
    const drafts = await followUpDraftsFor(prospectId);
    expect(drafts).toHaveLength(0);
  });
});

describe('PrepareFollowUpDraftsHandler — bounds and failure isolation', () => {
  it('respects ctx.maxItems', async () => {
    for (let i = 0; i < 3; i++) {
      const prospectId = await insertProspect();
      await dueSequenceFor(prospectId);
      detector.queueMessages([]);
    }
    const result = await handler.run(ctx({ maxItems: 1 }));
    expect(result.itemsProcessed).toBe(1);
  });
});
