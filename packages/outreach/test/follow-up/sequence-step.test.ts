import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { findNextSequenceStep } from '../../src/follow-up/sequence-step.js';

let db: MetrivioDb;
let sqlite: Database.Database;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
});

afterEach(() => sqlite.close());

async function insertProspect(): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({ id, xUsername: `user-${id.slice(0, 8)}`, source: 'founder_search', dateDiscovered: new Date().toISOString() });
  return id;
}

async function insertSequence(steps: Array<{ step_order: number; day_offset: number }>): Promise<string> {
  const id = uuid();
  await db.insert(schema.sequences).values({ id, name: 'test-sequence', steps: JSON.stringify(steps) });
  return id;
}

async function insertMessage(prospectId: string, sequenceId: string, stepOrder: number, status: 'sent' | 'queued', sentAt?: string): Promise<void> {
  await db.insert(schema.outreachMessages).values({
    id: uuid(),
    prospectId,
    sequenceId,
    sequenceStepOrder: stepOrder,
    messageContent: 'hi',
    channel: 'dm',
    status,
    sentAt,
  });
}

describe('findNextSequenceStep', () => {
  it('returns noPriorSentMessage when nothing has ever been sent', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }]);
    const result = await findNextSequenceStep(db, prospectId, sequenceId);
    expect(result.noPriorSentMessage).toBe(true);
    expect(result.info).toBeNull();
  });

  it('returns noNextStepDefined when the sequence has no step after the last sent one', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([{ step_order: 1, day_offset: 0 }]);
    await insertMessage(prospectId, sequenceId, 1, 'sent', new Date().toISOString());
    const result = await findNextSequenceStep(db, prospectId, sequenceId);
    expect(result.noNextStepDefined).toBe(true);
    expect(result.info).toBeNull();
  });

  it('resolves the next step and its day_offset', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 3 },
    ]);
    await insertMessage(prospectId, sequenceId, 1, 'sent', new Date().toISOString());
    const result = await findNextSequenceStep(db, prospectId, sequenceId);
    expect(result.info?.nextStepOrder).toBe(2);
    expect(result.info?.nextStepDayOffset).toBe(3);
    expect(result.info?.isLastStep).toBe(true);
  });

  it('isLastStep is false when a further step exists after the next one', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 3 },
      { step_order: 3, day_offset: 7 },
    ]);
    await insertMessage(prospectId, sequenceId, 1, 'sent', new Date().toISOString());
    const result = await findNextSequenceStep(db, prospectId, sequenceId);
    expect(result.info?.nextStepOrder).toBe(2);
    expect(result.info?.isLastStep).toBe(false);
  });

  it('detects nextStepAlreadySent when a queued or sent row exists at the next step', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 3 },
    ]);
    await insertMessage(prospectId, sequenceId, 1, 'sent', new Date().toISOString());
    await insertMessage(prospectId, sequenceId, 2, 'queued');
    const result = await findNextSequenceStep(db, prospectId, sequenceId);
    expect(result.nextStepAlreadySent).toBe(true);
  });

  it('nextStepAlreadySent is false when no such row exists', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 3 },
    ]);
    await insertMessage(prospectId, sequenceId, 1, 'sent', new Date().toISOString());
    const result = await findNextSequenceStep(db, prospectId, sequenceId);
    expect(result.nextStepAlreadySent).toBe(false);
  });

  it('uses the highest-step-order sent message when multiple exist', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence([
      { step_order: 1, day_offset: 0 },
      { step_order: 2, day_offset: 3 },
      { step_order: 3, day_offset: 7 },
    ]);
    await insertMessage(prospectId, sequenceId, 1, 'sent', new Date(Date.now() - 100000).toISOString());
    await insertMessage(prospectId, sequenceId, 2, 'sent', new Date().toISOString());
    const result = await findNextSequenceStep(db, prospectId, sequenceId);
    expect(result.info?.nextStepOrder).toBe(3);
  });
});
