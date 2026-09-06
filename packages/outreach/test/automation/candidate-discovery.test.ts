import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { findActiveSequenceCandidates } from '../../src/automation/candidate-discovery.js';

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

async function insertSequence(): Promise<string> {
  const id = uuid();
  await db.insert(schema.sequences).values({ id, name: 'test-sequence', steps: JSON.stringify([{ step_order: 1, day_offset: 0 }]) });
  return id;
}

async function insertMessage(prospectId: string, sequenceId: string, stepOrder: number, status: 'sent' | 'queued' | 'failed' = 'sent'): Promise<void> {
  await db.insert(schema.outreachMessages).values({
    id: uuid(),
    prospectId,
    sequenceId,
    sequenceStepOrder: stepOrder,
    messageContent: 'hi',
    channel: 'dm',
    status,
    sentAt: status === 'sent' ? new Date().toISOString() : undefined,
  });
}

describe('findActiveSequenceCandidates', () => {
  it('returns an empty list when nothing has been sent', async () => {
    const result = await findActiveSequenceCandidates(db, 25);
    expect(result).toEqual([]);
  });

  it('finds a candidate for a prospect+sequence with a sent message', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence();
    await insertMessage(prospectId, sequenceId, 1);

    const result = await findActiveSequenceCandidates(db, 25);
    expect(result).toEqual([{ prospectId, sequenceId }]);
  });

  it('never includes a candidate whose only outreach_messages rows are queued/failed (not sent)', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence();
    await insertMessage(prospectId, sequenceId, 1, 'queued');
    await insertMessage(prospectId, sequenceId, 2, 'failed');

    const result = await findActiveSequenceCandidates(db, 25);
    expect(result).toEqual([]);
  });

  it('deduplicates multiple sent rows for the same prospect+sequence into a single candidate', async () => {
    const prospectId = await insertProspect();
    const sequenceId = await insertSequence();
    await insertMessage(prospectId, sequenceId, 1);
    await insertMessage(prospectId, sequenceId, 2);

    const result = await findActiveSequenceCandidates(db, 25);
    expect(result).toEqual([{ prospectId, sequenceId }]);
  });

  it('respects the maxCandidates bound', async () => {
    for (let i = 0; i < 5; i++) {
      const prospectId = await insertProspect();
      const sequenceId = await insertSequence();
      await insertMessage(prospectId, sequenceId, 1);
    }
    const result = await findActiveSequenceCandidates(db, 3);
    expect(result).toHaveLength(3);
  });

  it('is deterministic — repeated calls against unchanged state return the same ordered list', async () => {
    for (let i = 0; i < 3; i++) {
      const prospectId = await insertProspect();
      const sequenceId = await insertSequence();
      await insertMessage(prospectId, sequenceId, 1);
    }
    const first = await findActiveSequenceCandidates(db, 25);
    const second = await findActiveSequenceCandidates(db, 25);
    expect(first).toEqual(second);
  });
});
