import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReplyDetectorAdapter, type ConversationMessageObservation } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ReplyDetectionService } from '../../src/follow-up/reply-detection-service.js';
import { FollowUpEligibilityService } from '../../src/follow-up/follow-up-eligibility-service.js';

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
let replyDetection: ReplyDetectionService;
let service: FollowUpEligibilityService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  detector = new ScriptedReplyDetector();
  replyDetection = new ReplyDetectionService(db, detector);
  service = new FollowUpEligibilityService(db, replyDetection);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
});

afterEach(() => sqlite.close());

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

async function insertSentMessage(prospectId: string, sequenceId: string, stepOrder: number, sentAt: string, status: 'sent' | 'queued' = 'sent'): Promise<void> {
  await db.insert(schema.outreachMessages).values({
    id: uuid(),
    prospectId,
    sequenceId,
    sequenceStepOrder: stepOrder,
    messageContent: 'hi',
    channel: 'dm',
    status,
    sentAt: status === 'sent' ? sentAt : undefined,
  });
}

describe('FollowUpEligibilityService.evaluate — due/not due', () => {
  it('is ELIGIBLE when the next steps day_offset has elapsed and there is no reply', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 3 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([]);

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('ELIGIBLE');
  });

  it('is NOT_DUE when the day_offset has not elapsed', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 30 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date().toISOString());
    detector.queueMessages([]);

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('NOT_DUE');
  });
});

describe('FollowUpEligibilityService.evaluate — reply/stop/opt-out blocking', () => {
  it('REPLIED blocks eligibility even when timing is due', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([{ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'hey there', createdAt: new Date().toISOString() }]);

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('REPLIED');
  });

  it('OPTED_OUT blocks eligibility', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }, { step_order: 2, day_offset: 1 }]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([{ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'please stop contacting me', createdAt: new Date().toISOString() }]);

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('OPTED_OUT');
  });

  it('STOPPED blocks eligibility', async () => {
    const prospectId = await insertProspect({ outreachStatus: 'stopped_manual' });
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }, { step_order: 2, day_offset: 1 }]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('STOPPED');
  });
});

describe('FollowUpEligibilityService.evaluate — already sent / unknown / blocked', () => {
  it('ALREADY_SENT when the next step already has a sent/queued message', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }, { step_order: 2, day_offset: 1 }]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    await insertSentMessage(prospectId, sequenceId, 2, new Date().toISOString(), 'queued');
    detector.queueMessages([]);

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('ALREADY_SENT');
  });

  it('UNKNOWN when there is no prior sent message in the sequence at all', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }]);
    detector.queueMessages([]);

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('UNKNOWN');
  });

  it('UNKNOWN when no next-step definition exists in the sequence', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }]); // no step 2 defined
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([]);

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('UNKNOWN');
  });

  it('BLOCKED when the kill switch is active, without calling reply detection', async () => {
    await config.setKillSwitch(true, 'test');
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }, { step_order: 2, day_offset: 1 }]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());

    const result = await service.evaluate(prospectId, sequenceId);
    expect(result.status).toBe('BLOCKED');
  });
});

describe('FollowUpEligibilityService.evaluate — determinism', () => {
  it('repeated evaluation with unchanged state produces the same result', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }, { step_order: 2, day_offset: 30 }]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date().toISOString());
    detector.queueMessages([]);
    detector.queueMessages([]);

    const first = await service.evaluate(prospectId, sequenceId);
    const second = await service.evaluate(prospectId, sequenceId);
    expect(first.status).toBe(second.status);
  });
});
