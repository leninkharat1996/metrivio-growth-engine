import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XSendAdapter, type XReplyDetectorAdapter, type SendDirectMessageInput, type SendDirectMessageResult, type ConversationMessageObservation } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { OutreachDraftService } from '../../src/drafts/draft-store.js';
import { SendApprovedDraftService } from '../../src/send/send-service.js';
import { ReplyDetectionService } from '../../src/follow-up/reply-detection-service.js';
import { FollowUpEligibilityService } from '../../src/follow-up/follow-up-eligibility-service.js';
import type { EvidenceRowInput } from '../../src/personalization/personalization-candidates.js';

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
let draftService: OutreachDraftService;
let sendAdapter: ScriptedSendAdapter;
let detector: ScriptedReplyDetector;
let eligibilityService: FollowUpEligibilityService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  draftService = new OutreachDraftService(db);
  sendAdapter = new ScriptedSendAdapter();
  detector = new ScriptedReplyDetector();
  eligibilityService = new FollowUpEligibilityService(db, new ReplyDetectionService(db, detector));
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  await config.setDailyLimit('dms', 10, 'test');
});

afterEach(() => sqlite.close());

function evidenceRow(overrides: Partial<EvidenceRowInput> = {}): EvidenceRowInput {
  return { id: 'e1', evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo', evidenceTier: 'CONFIRMED', rawValue: 'Founder', sourceUrl: null, ...overrides };
}

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({
    id,
    xUsername: `user-${id.slice(0, 8)}`,
    xUserId: `xid-${id.slice(0, 8)}`,
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

/** Creates an APPROVED follow-up-shaped draft directly (bypassing FollowUpDraftService, which is tested separately) so this file can focus purely on SendApprovedDraftService's own reply-recheck/dedup behavior. */
async function approvedFollowUpDraftFor(prospectId: string, sequenceId: string, sequenceStepOrder: number): Promise<string> {
  const { draft } = await draftService.generateDraft({
    prospectId,
    displayName: 'Jane Founder',
    companyName: 'Acme',
    evidenceRows: [evidenceRow()],
    painSignals: [],
    technologyDetections: [],
    followUp: { sequenceId, sequenceStepOrder, followUpIntent: 'reminder' },
  });
  await draftService.submitForApproval(draft.id);
  await draftService.approve(draft.id, 'reviewer-1');
  return draft.id;
}

async function insertSentMessage(prospectId: string, sequenceId: string, stepOrder: number, sentAt: string): Promise<void> {
  await db.insert(schema.outreachMessages).values({
    id: uuid(),
    prospectId,
    sequenceId,
    sequenceStepOrder: stepOrder,
    messageContent: 'hi',
    channel: 'dm',
    status: 'sent',
    sentAt,
  });
}

describe('SendApprovedDraftService — sequence-aware dedup key (Section I)', () => {
  it('a follow-up drafts own sequenceId/sequenceStepOrder is used as the dedup key, not the manual-send singleton', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);
    sendAdapter.queueSuccess({ xMessageId: 'f1', sentAt: new Date().toISOString() });

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('SENT');

    const rows = await db
      .select()
      .from(schema.outreachMessages)
      .where(and(eq(schema.outreachMessages.prospectId, prospectId), eq(schema.outreachMessages.sequenceId, sequenceId), eq(schema.outreachMessages.sequenceStepOrder, 2)));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
  });

  it('never sends the same prospect+sequence+step twice — a second attempt for the identical follow-up step is blocked', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);
    sendAdapter.queueSuccess({ xMessageId: 'f1', sentAt: new Date().toISOString() });
    await service.send({ draftId, prospectId });

    sendAdapter.queueSuccess({ xMessageId: 'f2', sentAt: new Date().toISOString() });
    const second = await service.send({ draftId, prospectId });
    expect(second.outcome).toBe('ALREADY_SENT');
    expect(sendAdapter.calls).toHaveLength(1);
  });

  it('a follow-up at a different step never collides with an earlier step for the same prospect+sequence', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
      { step_order: 3, day_offset: 5 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString());
    await insertSentMessage(prospectId, sequenceId, 2, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 3);
    sendAdapter.queueSuccess({ xMessageId: 'f3', sentAt: new Date().toISOString() });

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('SENT');
  });

  it('an original (non-follow-up) draft still uses the manual-send singleton exactly as before (Stage 6B behavior preserved)', async () => {
    const prospectId = await insertProspect();
    const { draft } = await draftService.generateDraft({ prospectId, displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await draftService.submitForApproval(draft.id);
    await draftService.approve(draft.id, 'reviewer-1');
    const service = new SendApprovedDraftService(db, draftService, sendAdapter);
    sendAdapter.queueSuccess({ xMessageId: 'o1', sentAt: new Date().toISOString() });

    const result = await service.send({ draftId: draft.id, prospectId });
    expect(result.outcome).toBe('SENT');

    const rows = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.prospectId, prospectId));
    expect(rows).toHaveLength(1);
    expect(rows[0].sequenceId).not.toBe(''); // uses the manual-send singleton id, whatever it resolved to
  });
});

describe('SendApprovedDraftService — mandatory pre-send reply-recheck (Section C)', () => {
  it('without a FollowUpEligibilityService dependency, an original draft sends exactly as Stage 6B did (backward compatible)', async () => {
    const prospectId = await insertProspect();
    const { draft } = await draftService.generateDraft({ prospectId, displayName: 'Jane', companyName: 'Acme', evidenceRows: [evidenceRow()], painSignals: [], technologyDetections: [] });
    await draftService.submitForApproval(draft.id);
    await draftService.approve(draft.id, 'reviewer-1');
    const service = new SendApprovedDraftService(db, draftService, sendAdapter); // no followUpEligibilityService
    sendAdapter.queueSuccess({ xMessageId: 'm1', sentAt: new Date().toISOString() });

    const result = await service.send({ draftId: draft.id, prospectId });
    expect(result.outcome).toBe('SENT');
  });

  it('blocks the send when the prospect replied after the draft was generated (critical: reply means no send)', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, eligibilityService);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);

    detector.queueMessages([{ xMessageId: 'r1', senderXUserId: 'prospect-x-id', text: 'hey there', createdAt: new Date().toISOString() }]);
    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('REPLIED');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('blocks the send when the prospect opted out immediately before send (critical: opt-out means no send)', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, eligibilityService);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);

    detector.queueMessages([{ xMessageId: 'r1', senderXUserId: 'prospect-x-id', text: 'please stop messaging me', createdAt: new Date().toISOString() }]);
    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('OPTED_OUT');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('blocks the send when the prospect is in a stopped state (critical: stopped means no send)', async () => {
    const prospectId = await insertProspect({ outreachStatus: 'stopped_manual' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, eligibilityService);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('STOPPED');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('blocks the send when reply state cannot be determined (critical: unknown means no send)', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);

    const failingDetector: XReplyDetectorAdapter = {
      getConversationMessages: async () => {
        throw new Error('network down');
      },
    };
    const failingEligibility = new FollowUpEligibilityService(db, new ReplyDetectionService(db, failingDetector));
    const service2 = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, failingEligibility);

    const result = await service2.send({ draftId, prospectId });
    expect(result.outcome).toBe('FOLLOW_UP_INELIGIBLE');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('blocks the send when the follow-up is not yet due (critical: not-due means no send)', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 90 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date().toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, eligibilityService);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('NOT_DUE');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('blocks the send when the kill switch is active at recheck time, reported as BLOCKED (not conflated with a reply)', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, eligibilityService);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);
    await config.setKillSwitch(true, 'test');

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('BLOCKED');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('proceeds to send when the recheck confirms ELIGIBLE', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, eligibilityService);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);
    sendAdapter.queueSuccess({ xMessageId: 'f1', sentAt: new Date().toISOString() });

    const result = await service.send({ draftId, prospectId });
    expect(result.outcome).toBe('SENT');
  });

  it('dry-run still performs the reply-recheck and blocks without ever contacting X', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, eligibilityService);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);

    detector.queueMessages([{ xMessageId: 'r1', senderXUserId: 'prospect-x-id', text: 'hey', createdAt: new Date().toISOString() }]);
    const result = await service.send({ draftId, prospectId, dryRun: true });
    expect(result.outcome).toBe('REPLIED');
    expect(sendAdapter.calls).toHaveLength(0);
  });

  it('a dry run that IS eligible reports DRY_RUN without sending', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    const service = new SendApprovedDraftService(db, draftService, sendAdapter, undefined, eligibilityService);
    const draftId = await approvedFollowUpDraftFor(prospectId, sequenceId, 2);

    const result = await service.send({ draftId, prospectId, dryRun: true });
    expect(result.outcome).toBe('DRY_RUN');
    expect(sendAdapter.calls).toHaveLength(0);
  });
});
