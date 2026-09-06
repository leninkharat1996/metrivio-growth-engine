import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReplyDetectorAdapter, type ConversationMessageObservation } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ReplyDetectionService } from '../../src/follow-up/reply-detection-service.js';
import { RefreshReplyStateHandler } from '../../src/automation/refresh-reply-state-handler.js';

class ScriptedReplyDetector implements XReplyDetectorAdapter {
  private queue: Array<ConversationMessageObservation[] | Error> = [];
  queueMessages(messages: ConversationMessageObservation[]): void {
    this.queue.push(messages);
  }
  queueError(err: Error): void {
    this.queue.push(err);
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
let handler: RefreshReplyStateHandler;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  detector = new ScriptedReplyDetector();
  handler = new RefreshReplyStateHandler(db, new ReplyDetectionService(db, detector));
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

async function insertSequence(): Promise<string> {
  const id = uuid();
  await db.insert(schema.sequences).values({ id, name: 'test-sequence', steps: JSON.stringify([{ step_order: 1, day_offset: 0 }]) });
  return id;
}

async function insertSentMessage(prospectId: string, sequenceId: string): Promise<void> {
  await db.insert(schema.outreachMessages).values({ id: uuid(), prospectId, sequenceId, sequenceStepOrder: 1, messageContent: 'hi', channel: 'dm', status: 'sent', sentAt: new Date().toISOString() });
}

function ctx(overrides: Partial<{ maxItems: number }> = {}) {
  return { runId: 'run-1', dryRun: false, maxItems: overrides.maxItems ?? 25, checkpoint: null, updateCheckpoint: async () => undefined };
}

describe('RefreshReplyStateHandler — delegates entirely to ReplyDetectionService', () => {
  it('detects a reply', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence();
    await insertSentMessage(prospectId, sequenceId);
    detector.queueMessages([{ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'hey', createdAt: new Date().toISOString() }]);

    const result = await handler.run(ctx());
    expect(result.itemsSucceeded).toBe(1);
    expect(result.detail?.byReplyState).toEqual({ REPLIED: 1 });
  });

  it('reports NO_REPLY for a clean check', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence();
    await insertSentMessage(prospectId, sequenceId);
    detector.queueMessages([]);

    const result = await handler.run(ctx());
    expect(result.detail?.byReplyState).toEqual({ NO_REPLY: 1 });
  });

  it('a network error is never reported as NO_REPLY', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence();
    await insertSentMessage(prospectId, sequenceId);
    detector.queueError(new Error('network down'));

    const result = await handler.run(ctx());
    expect(result.detail?.byReplyState).toEqual({ UNKNOWN: 1 });
    expect(result.itemsFailed).toBe(1);
  });

  it('an auth-shaped failure is reported as UNKNOWN, not silently dropped', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence();
    await insertSentMessage(prospectId, sequenceId);
    detector.queueError(new Error('auth required'));

    const result = await handler.run(ctx());
    expect(result.detail?.byReplyState).toEqual({ UNKNOWN: 1 });
  });

  it('never creates another X inbox implementation — one candidate is one detectReplies() call', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence();
    await insertSentMessage(prospectId, sequenceId);
    let calls = 0;
    const countingDetector: XReplyDetectorAdapter = {
      getConversationMessages: async () => {
        calls += 1;
        return [];
      },
    };
    const countingHandler = new RefreshReplyStateHandler(db, new ReplyDetectionService(db, countingDetector));
    await countingHandler.run(ctx());
    expect(calls).toBe(1);
  });
});

describe('RefreshReplyStateHandler — bounds and failure isolation', () => {
  it('respects ctx.maxItems', async () => {
    for (let i = 0; i < 4; i++) {
      const prospectId = await insertProspect();
      const sequenceId = await insertSequence();
      await insertSentMessage(prospectId, sequenceId);
      detector.queueMessages([]);
    }
    const result = await handler.run(ctx({ maxItems: 2 }));
    expect(result.itemsProcessed).toBe(2);
  });

  it('one failing prospect does not stop the others from being processed', async () => {
    const p1 = await insertProspect();
    const s1 = await insertSequence();
    await insertSentMessage(p1, s1);
    const p2 = await insertProspect();
    const s2 = await insertSequence();
    await insertSentMessage(p2, s2);

    detector.queueError(new Error('network down'));
    detector.queueMessages([]);

    const result = await handler.run(ctx());
    expect(result.itemsProcessed).toBe(2);
  });
});
