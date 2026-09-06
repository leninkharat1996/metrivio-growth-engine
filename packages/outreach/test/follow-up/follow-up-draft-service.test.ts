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
import { SendApprovedDraftService } from '../../src/send/send-service.js';
import type { SendDirectMessageInput, SendDirectMessageResult } from '@metrivio/core';
import type { XSendAdapter } from '@metrivio/core';

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

class ScriptedSendAdapter implements XSendAdapter {
  public calls: SendDirectMessageInput[] = [];
  private queue: Array<SendDirectMessageResult | Error> = [];
  queueSuccess(result: SendDirectMessageResult): void {
    this.queue.push(result);
  }
  async sendDirectMessage(input: SendDirectMessageInput): Promise<SendDirectMessageResult> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('no queued response');
    if (next instanceof Error) throw next;
    return next;
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let detector: ScriptedReplyDetector;
let replyDetection: ReplyDetectionService;
let eligibility: FollowUpEligibilityService;
let draftGeneration: DraftGenerationService;
let followUpDrafts: FollowUpDraftService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  detector = new ScriptedReplyDetector();
  replyDetection = new ReplyDetectionService(db, detector);
  eligibility = new FollowUpEligibilityService(db, replyDetection);
  draftGeneration = new DraftGenerationService(db);
  followUpDrafts = new FollowUpDraftService(db, draftGeneration, eligibility);
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

async function insertEvidence(prospectId: string, overrides: Partial<typeof schema.evidence.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.evidence).values({
    id,
    prospectId,
    evidenceType: 'decision_maker_signal',
    signalCategory: 'role_founder_or_ceo',
    evidenceTier: 'CONFIRMED',
    rawValue: 'Founder',
    sourceUrl: null,
    ...overrides,
  });
  return id;
}

/** Sends an original approved draft through the real send boundary so `outreach_messages`/personalizationBasis are populated exactly like production. */
async function sendOriginalMessage(prospectId: string, sequenceId: string): Promise<void> {
  const { draft } = await draftGeneration.generateDraftForProspect(prospectId);
  await draftGeneration.drafts.submitForApproval(draft.id);
  await draftGeneration.drafts.approve(draft.id, 'reviewer-1');

  const sendAdapter = new ScriptedSendAdapter();
  sendAdapter.queueSuccess({ xMessageId: 'orig-1', sentAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() });
  const sendService = new SendApprovedDraftService(db, draftGeneration.drafts, sendAdapter);

  // The original send used the manual-send singleton sequence by default;
  // re-point that row onto our real test sequence/step 1 so eligibility's
  // "last sent step in this sequence" lookup finds it, exactly like a real
  // sequence-driven send would populate sequence_id/sequence_step_order.
  await sendService.send({ draftId: draft.id, prospectId });
  await db
    .update(schema.outreachMessages)
    .set({ sequenceId, sequenceStepOrder: 1 })
    .where(eq(schema.outreachMessages.prospectId, prospectId));
}

describe('FollowUpDraftService — eligibility integration', () => {
  it('drafts when eligibility is ELIGIBLE', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('DRAFTED');
    expect(result.draft).toBeTruthy();
  });

  it('does not draft when NOT_DUE', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 90 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('NOT_DUE');
    expect(result.draft).toBeUndefined();
  });

  it('does not draft when REPLIED', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([{ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'hey', createdAt: new Date().toISOString() }]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('REPLIED');
  });

  it('does not draft when STOPPED', async () => {
    const prospectId = await insertProspect({ outreachStatus: 'stopped_manual' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('STOPPED');
  });

  it('does not draft when OPTED_OUT', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([{ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'please stop contacting me', createdAt: new Date().toISOString() }]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('OPTED_OUT');
  });

  it('does not draft when BLOCKED (kill switch)', async () => {
    await config.setKillSwitch(true, 'test');
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('BLOCKED');
  });

  it('does not draft when ALREADY_SENT', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    await db.insert(schema.outreachMessages).values({
      id: uuid(),
      prospectId,
      sequenceId,
      sequenceStepOrder: 2,
      messageContent: 'x',
      channel: 'dm',
      status: 'queued',
    });
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('ALREADY_SENT');
  });

  it('does not draft when UNKNOWN (no prior sent message in the sequence at all)', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('UNKNOWN');
  });

  it('returns NO_NEXT_STEP (not generic UNKNOWN) when the sequence defines no step after the sent one', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.outcome).toBe('NO_NEXT_STEP');
  });
});

describe('FollowUpDraftService — sequence step mapping', () => {
  it('associates the drafted follow-up with the correct next sequence step order', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.draft?.sequenceId).toBe(sequenceId);
    expect(result.draft?.sequenceStepOrder).toBe(2);
  });

  it('uses "clarification" intent for the first follow-up (step 2 of 3)', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
      { step_order: 3, day_offset: 5 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.draft?.followUpIntent).toBe('clarification');
  });

  it('uses "final_close" intent for the last defined step', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.draft?.followUpIntent).toBe('final_close');
  });

  it('uses "reminder" intent for a second follow-up that is not the final step', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
      { step_order: 3, day_offset: 5 },
      { step_order: 4, day_offset: 10 },
    ]);
    await insertEvidence(prospectId);
    // simulate step 2 already sent, so the next step is 3 (second follow-up)
    await sendOriginalMessage(prospectId, sequenceId);
    await db.update(schema.outreachMessages).set({ sequenceStepOrder: 2 }).where(eq(schema.outreachMessages.prospectId, prospectId));
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.draft?.sequenceStepOrder).toBe(3);
    expect(result.draft?.followUpIntent).toBe('reminder');
  });

  it('records the parent outreach message id on the follow-up draft', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const originalRows = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.prospectId, prospectId));
    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.draft?.parentOutreachMessageId).toBe(originalRows[0].id);
  });
});

describe('FollowUpDraftService — personalization', () => {
  it('excludes the original hooks evidenceId from the follow-up candidate pool', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    const originalEvidenceId = await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo' });
    await sendOriginalMessage(prospectId, sequenceId);
    // add a second, distinct piece of evidence available only for the follow-up
    await insertEvidence(prospectId, { id: uuid(), evidenceType: 'trigger_signal', signalCategory: 'recent_funding_round', sourceUrl: 'https://example.com/news' });
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.draft?.selectedHook?.evidenceId).not.toBe(originalEvidenceId);
    expect(result.draft?.evidenceReferences).not.toContain(originalEvidenceId);
  });

  it('the follow-up message text is deterministic given the same inputs', async () => {
    const prospectId1 = await insertProspect();
    const sequenceId1 = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId1);
    await sendOriginalMessage(prospectId1, sequenceId1);
    detector.queueMessages([]);
    const first = await followUpDrafts.generateFollowUpDraft(prospectId1, sequenceId1);

    // A second, freshly-generated draft for a second prospect with identical inputs should render identical message text.
    const prospectId2 = await insertProspect();
    const sequenceId2 = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId2);
    await sendOriginalMessage(prospectId2, sequenceId2);
    detector.queueMessages([]);
    const second = await followUpDrafts.generateFollowUpDraft(prospectId2, sequenceId2);

    expect(first.draft?.messageText).toBe(second.draft?.messageText);
  });

  it('the follow-up message never repeats the exact original message text', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const originalRows = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.prospectId, prospectId));
    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.draft?.messageText).not.toBe(originalRows[0].messageContent);
  });
});

describe('FollowUpDraftService — approval flow reuse (idempotency)', () => {
  it('a follow-up draft goes through the same DRAFTED -> PENDING_APPROVAL -> APPROVED state machine', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const result = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(result.draft?.status).toBe('DRAFTED');

    const draftId = result.draft!.id;
    await draftGeneration.drafts.submitForApproval(draftId);
    const pending = await draftGeneration.drafts.getDraft(draftId);
    expect(pending?.status).toBe('PENDING_APPROVAL');

    await draftGeneration.drafts.approve(draftId, 'reviewer-1');
    const approved = await draftGeneration.drafts.getDraft(draftId);
    expect(approved?.status).toBe('APPROVED');
  });

  it('does not generate a second in-flight follow-up draft while one is already non-terminal', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertEvidence(prospectId);
    await sendOriginalMessage(prospectId, sequenceId);
    detector.queueMessages([]);
    const first = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);

    detector.queueMessages([]);
    const second = await followUpDrafts.generateFollowUpDraft(prospectId, sequenceId);
    expect(second.draft?.id).toBe(first.draft?.id);
    expect(second.created).toBe(false);
  });
});
