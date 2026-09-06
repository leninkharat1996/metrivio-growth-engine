import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReplyDetectorAdapter, type ConversationMessageObservation } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ReplyDetectionService } from '../../src/follow-up/reply-detection-service.js';
import { FollowUpEligibilityService } from '../../src/follow-up/follow-up-eligibility-service.js';
import { DueWorkDiscoveryService } from '../../src/automation/due-work-discovery-service.js';
import { DiscoverDueFollowUpsHandler } from '../../src/automation/discover-due-followups-handler.js';

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
let handler: DiscoverDueFollowUpsHandler;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  detector = new ScriptedReplyDetector();
  const eligibilityService = new FollowUpEligibilityService(db, new ReplyDetectionService(db, detector));
  handler = new DiscoverDueFollowUpsHandler(db, new DueWorkDiscoveryService(db, eligibilityService));
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
});

afterEach(() => sqlite.close());

async function insertProspect(): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({ id, xUsername: `user-${id.slice(0, 8)}`, xUserId: `xid-${id.slice(0, 8)}`, source: 'founder_search', dateDiscovered: new Date().toISOString() });
  return id;
}

async function insertSequence(steps: Array<{ step_order: number; day_offset: number }>): Promise<string> {
  const id = uuid();
  await db.insert(schema.sequences).values({ id, name: 'test-sequence', steps: JSON.stringify(steps) });
  return id;
}

async function insertSentMessage(prospectId: string, sequenceId: string, stepOrder: number, sentAt: string): Promise<void> {
  await db.insert(schema.outreachMessages).values({ id: uuid(), prospectId, sequenceId, sequenceStepOrder: stepOrder, messageContent: 'hi', channel: 'dm', status: 'sent', sentAt });
}

function ctx(overrides: Partial<{ runId: string; dryRun: boolean; maxItems: number; checkpoint: unknown }> = {}) {
  return {
    runId: overrides.runId ?? 'run-1',
    dryRun: overrides.dryRun ?? false,
    maxItems: overrides.maxItems ?? 25,
    checkpoint: overrides.checkpoint ?? null,
    updateCheckpoint: async () => undefined,
  };
}

describe('DiscoverDueFollowUpsHandler — never writes outreach_messages or creates a draft', () => {
  it('produces zero outreach_messages/audit_log outreach.draft.created rows even when a candidate is ELIGIBLE', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([]);

    await handler.run(ctx());

    const messages = await db.select().from(schema.outreachMessages).where(eq(schema.outreachMessages.sequenceStepOrder, 2));
    expect(messages).toHaveLength(0);
    const draftRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'outreach.draft.created'));
    expect(draftRows).toHaveLength(0);
  });
});

describe('DiscoverDueFollowUpsHandler — bounds and reporting', () => {
  it('reports itemsProcessed/itemsSucceeded matching the number of candidates found', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([]);

    const result = await handler.run(ctx());
    expect(result.itemsProcessed).toBe(1);
    expect(result.itemsSucceeded).toBe(1);
    expect(result.itemsFailed).toBe(0);
  });

  it('audits each candidate check without leaking message content', async () => {
    const prospectId = await insertProspect({} as never);
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([]);

    await handler.run(ctx());
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'automation.due_followup.checked'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.detail ?? '').not.toMatch(/auth_token|cookie|ct0/i);
    }
  });

  it('respects ctx.maxItems as the candidate bound', async () => {
    for (let i = 0; i < 4; i++) {
      const prospectId = await insertProspect();
      const sequenceId = await insertSequence([
        { step_order: 1, day_offset: 0 },
        { step_order: 2, day_offset: 1 },
      ]);
      await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
      detector.queueMessages([]);
    }
    const result = await handler.run(ctx({ maxItems: 2 }));
    expect(result.itemsProcessed).toBe(2);
  });
});
