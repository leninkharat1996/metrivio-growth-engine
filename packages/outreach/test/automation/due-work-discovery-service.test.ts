import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReplyDetectorAdapter, type ConversationMessageObservation } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ReplyDetectionService } from '../../src/follow-up/reply-detection-service.js';
import { FollowUpEligibilityService } from '../../src/follow-up/follow-up-eligibility-service.js';
import { DueWorkDiscoveryService } from '../../src/automation/due-work-discovery-service.js';

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
let eligibilityService: FollowUpEligibilityService;
let discovery: DueWorkDiscoveryService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  detector = new ScriptedReplyDetector();
  eligibilityService = new FollowUpEligibilityService(db, new ReplyDetectionService(db, detector));
  discovery = new DueWorkDiscoveryService(db, eligibilityService);
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

describe('DueWorkDiscoveryService.evaluateCandidate — business outcomes', () => {
  it('ELIGIBLE when the follow-up is due and there is no reply', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([]);

    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('ELIGIBLE');
  });

  it('NOT_DUE', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 90 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date().toISOString());
    detector.queueMessages([]);

    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('NOT_DUE');
  });

  it('REPLIED', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([{ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'hey', createdAt: new Date().toISOString() }]);

    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('REPLIED');
  });

  it('OPTED_OUT', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([{ xMessageId: 'm1', senderXUserId: 'prospect-x-id', text: 'please stop contacting me', createdAt: new Date().toISOString() }]);

    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('OPTED_OUT');
  });

  it('STOPPED', async () => {
    const prospectId = await insertProspect({ outreachStatus: 'stopped_manual' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());

    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('STOPPED');
  });

  it('UNKNOWN when reply detection fails (network error) — never NO_REPLY, never ELIGIBLE', async () => {
    const prospectId = await insertProspect({ xUserId: 'prospect-x-id' });
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueError(new Error('network down'));

    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('UNKNOWN');
  });

  it('ALREADY_SENT when the next step already has a queued/sent row', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
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

    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('ALREADY_SENT');
  });

  it('NO_NEXT_STEP (distinct from generic UNKNOWN) when the sequence defines nothing after the sent step', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    detector.queueMessages([]);

    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('NO_NEXT_STEP');
  });

  it('a generic UNKNOWN (no prior sent message resolvable in this sequence) is never mislabeled as NO_NEXT_STEP', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }]);
    // no sent message at all for this prospect/sequence
    const result = await discovery.evaluateCandidate({ prospectId, sequenceId });
    expect(result.status).toBe('UNKNOWN');
  });

  it('ERROR (never a legitimate business status) when evaluation itself throws unexpectedly', async () => {
    const brokenDiscovery = new DueWorkDiscoveryService(db, {
      evaluate: async () => {
        throw new Error('boom');
      },
    } as unknown as FollowUpEligibilityService);
    const result = await brokenDiscovery.evaluateCandidate({ prospectId: 'p1', sequenceId: 's1' });
    expect(result.status).toBe('ERROR');
  });
});

describe('DueWorkDiscoveryService.findDueFollowUps — bounds', () => {
  async function makeEligibleCandidate(): Promise<{ prospectId: string; sequenceId: string }> {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 1 },
    ]);
    await insertSentMessage(prospectId, sequenceId, 1, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    return { prospectId, sequenceId };
  }

  it('respects maxCandidates', async () => {
    for (let i = 0; i < 5; i++) {
      await makeEligibleCandidate();
      detector.queueMessages([]);
    }
    const { candidatesConsidered } = await discovery.findDueFollowUps({ maxCandidates: 2, maxReplyChecks: 10 });
    expect(candidatesConsidered).toBe(2);
  });

  it('respects maxReplyChecks independently of maxCandidates', async () => {
    for (let i = 0; i < 5; i++) {
      await makeEligibleCandidate();
      detector.queueMessages([]);
    }
    const { results, replyChecksPerformed } = await discovery.findDueFollowUps({ maxCandidates: 5, maxReplyChecks: 2 });
    expect(replyChecksPerformed).toBe(2);
    expect(results).toHaveLength(2);
  });

  it('one failing candidate does not prevent others from being evaluated', async () => {
    const a = await makeEligibleCandidate();
    const b = await makeEligibleCandidate();
    // Candidates are returned ordered by prospectId ascending — queue the
    // detector responses in THAT order so the "failing" response lands on
    // whichever of a/b actually sorts first.
    const [first, second] = [a, b].sort((x, y) => x.prospectId.localeCompare(y.prospectId));
    detector.queueError(new Error('network down'));
    detector.queueMessages([]);

    const { results } = await discovery.findDueFollowUps({ maxCandidates: 10, maxReplyChecks: 10 });
    const firstResult = results.find((r) => r.prospectId === first.prospectId);
    const secondResult = results.find((r) => r.prospectId === second.prospectId);
    expect(firstResult?.status).toBe('UNKNOWN');
    expect(secondResult?.status).toBe('ELIGIBLE');
  });

  it('is deterministic given unchanged state', async () => {
    await makeEligibleCandidate();
    detector.queueMessages([]);
    detector.queueMessages([]);
    const first = await discovery.findDueFollowUps({ maxCandidates: 10, maxReplyChecks: 10 });
    const second = await discovery.findDueFollowUps({ maxCandidates: 10, maxReplyChecks: 10 });
    expect(first.results.map((r) => r.status)).toEqual(second.results.map((r) => r.status));
  });
});
