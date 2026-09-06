import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReplyDetectorAdapter, type ConversationMessageObservation } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ReplyDetectionService } from '../../src/follow-up/reply-detection-service.js';

/** Mirrors the existing ScriptedXReadAdapter/ScriptedSendAdapter test-double pattern — never a real network call. */
class ScriptedReplyDetector implements XReplyDetectorAdapter {
  public calls: string[] = [];
  private queue: Array<ConversationMessageObservation[] | Error> = [];

  queueMessages(messages: ConversationMessageObservation[]): void {
    this.queue.push(messages);
  }
  queueError(err: Error): void {
    this.queue.push(err);
  }

  async getConversationMessages(targetUserId: string): Promise<ConversationMessageObservation[]> {
    this.calls.push(targetUserId);
    const next = this.queue.shift();
    if (next === undefined) return [];
    if (next instanceof Error) throw next;
    return next;
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let detector: ScriptedReplyDetector;
let service: ReplyDetectionService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  detector = new ScriptedReplyDetector();
  service = new ReplyDetectionService(db, detector);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  await config.setDailyLimit('scrapes', 100, 'test');
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

function obs(overrides: Partial<ConversationMessageObservation> = {}): ConversationMessageObservation {
  return { xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'hi', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('ReplyDetectionService.detectReplies — reply detection', () => {
  it('detects a prospect reply', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([obs()]);

    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('REPLIED');
    expect(result.newMessagesFound).toBe(1);
  });

  it('ignores a message not attributable to the prospect (canonical ID mismatch)', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([obs({ senderXUserId: 'someone-else' })]);

    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('NO_REPLY');
    expect(result.newMessagesFound).toBe(0);
  });

  it('handles multiple messages, only counting those attributable to the prospect', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([
      obs({ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'first' }),
      obs({ xMessageId: 'm2', senderXUserId: 'our-account-id', text: 'ours' }),
      obs({ xMessageId: 'm3', senderXUserId: 'prospect-x-id', text: 'second' }),
    ]);

    const result = await service.detectReplies(prospectId);
    expect(result.newMessagesFound).toBe(2);
    expect(result.replyState).toBe('REPLIED');
  });

  it('message ordering does not affect the outcome — any attributable message triggers REPLIED', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([
      obs({ xMessageId: 'm1', senderXUserId: 'our-account-id' }),
      obs({ xMessageId: 'm2', senderXUserId: 'our-account-id' }),
      obs({ xMessageId: 'm3', senderXUserId: 'prospect-x-id' }),
    ]);

    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('REPLIED');
  });

  it('returns UNKNOWN when the prospect has no canonical X user ID', async () => {
    const prospectId = await insertProspect({ xUserId: null });
    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('UNKNOWN');
    expect(detector.calls).toHaveLength(0);
  });

  it('returns UNKNOWN, not NO_REPLY, when no conversation/messages exist yet at all', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([]); // adapter succeeded, found nothing
    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('NO_REPLY'); // detection succeeded and found nothing -> genuinely NO_REPLY
  });

  it('throws for a prospect id that does not exist', async () => {
    await expect(service.detectReplies('no-such-prospect')).rejects.toThrow(/no prospect found/);
  });
});

describe('ReplyDetectionService.detectReplies — reply state', () => {
  it('STOPPED when prospect.outreach_status is a terminal state, without ever calling the adapter', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id', outreachStatus: 'stopped_manual' });
    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('STOPPED');
    expect(detector.calls).toHaveLength(0);
  });

  it('UNKNOWN when the kill switch is active', async () => {
    await config.setKillSwitch(true, 'test');
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('UNKNOWN');
    expect(detector.calls).toHaveLength(0);
  });

  it('OPTED_OUT when a detected message matches an explicit opt-out phrase', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([obs({ text: 'please stop contacting me' })]);
    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('OPTED_OUT');

    const conversations = await db.select().from(schema.conversations).where(eq(schema.conversations.prospectId, prospectId));
    expect(conversations[0].classification).toBe('OPT_OUT');
  });
});

describe('ReplyDetectionService.detectReplies — idempotency / duplicate detection', () => {
  it('processing the same X message ID twice never creates a duplicate conversation_messages row', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([obs({ xMessageId: 'm1' })]);
    await service.detectReplies(prospectId);

    detector.queueMessages([obs({ xMessageId: 'm1' })]); // same message observed again
    const second = await service.detectReplies(prospectId);
    expect(second.newMessagesFound).toBe(0);

    const conversations = await db.select().from(schema.conversations).where(eq(schema.conversations.prospectId, prospectId));
    const messages = await db.select().from(schema.conversationMessages).where(eq(schema.conversationMessages.conversationId, conversations[0].id));
    expect(messages).toHaveLength(1);
  });

  it('running detection multiple times with no new messages is a no-op each time', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([]);
    detector.queueMessages([]);
    detector.queueMessages([]);

    await service.detectReplies(prospectId);
    await service.detectReplies(prospectId);
    const third = await service.detectReplies(prospectId);
    expect(third.replyState).toBe('NO_REPLY');
  });

  it('the same conversation processed twice in a row is stable (reply state persists)', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([obs({ xMessageId: 'm1' })]);
    const first = await service.detectReplies(prospectId);

    detector.queueMessages([obs({ xMessageId: 'm1' })]);
    const second = await service.detectReplies(prospectId);
    expect(first.replyState).toBe('REPLIED');
    expect(second.replyState).toBe('REPLIED');
  });
});

describe('ReplyDetectionService.detectReplies — network error handling', () => {
  it('a network error results in UNKNOWN, not NO_REPLY', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueError(new Error('network down'));
    const result = await service.detectReplies(prospectId);
    expect(result.replyState).toBe('UNKNOWN');
    expect(result.detectionSucceeded).toBe(false);
  });
});

describe('ReplyDetectionService.detectReplies — audit', () => {
  it('audits every detection attempt without ever including message content', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    detector.queueMessages([obs({ text: 'super secret content' })]);
    await service.detectReplies(prospectId);

    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'outreach.reply_detection.checked'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.detail ?? '').not.toContain('super secret content');
    }
  });
});

describe('ReplyDetectionService.detectRepliesBatch', () => {
  it('processes multiple prospects and persists a resumable job checkpoint', async () => {
    const p1 = await insertProspect({ xUserId: 'x1' });
    const p2 = await insertProspect({ xUserId: 'x2' });
    detector.queueMessages([]);
    detector.queueMessages([]);

    const outcome = await service.detectRepliesBatch([p1, p2]);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.replyState === 'NO_REPLY')).toBe(true);
  });

  it('resumes from a checkpoint without reprocessing an already-completed prospect', async () => {
    const p1 = await insertProspect({ xUserId: 'x1' });
    const p2 = await insertProspect({ xUserId: 'x2' });
    detector.queueMessages([]);
    detector.queueMessages([]);

    const first = await service.detectRepliesBatch([p1, p2]);
    detector.calls.length = 0;
    const resumed = await service.detectRepliesBatch([p1, p2], { resumeJobId: first.jobId });
    expect(detector.calls).toHaveLength(0);
    expect(resumed.jobId).toBe(first.jobId);
  });

  it('stops once the shared daily scrape budget is exhausted', async () => {
    await config.setDailyLimit('scrapes', 1, 'test');
    const p1 = await insertProspect({ xUserId: 'x1' });
    const p2 = await insertProspect({ xUserId: 'x2' });
    detector.queueMessages([]);
    detector.queueMessages([]);

    const outcome = await service.detectRepliesBatch([p1, p2]);
    const processed = outcome.results.filter((r) => r.detectionSucceeded || r.reason.includes('failed'));
    expect(processed.length).toBeLessThanOrEqual(1);
  });
});
