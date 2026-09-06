import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { getOrCreateManualSendSequenceId, MANUAL_SEND_SEQUENCE_NAME } from '../../src/send/manual-sequence.js';

let db: MetrivioDb;
let sqlite: Database.Database;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
});

afterEach(() => sqlite.close());

describe('getOrCreateManualSendSequenceId', () => {
  it('creates the sequence row on first use', async () => {
    const id = await getOrCreateManualSendSequenceId(db);
    const rows = await db.select().from(schema.sequences);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].name).toBe(MANUAL_SEND_SEQUENCE_NAME);
  });

  it('returns the same id on every subsequent call (idempotent, never duplicates the row)', async () => {
    const first = await getOrCreateManualSendSequenceId(db);
    const second = await getOrCreateManualSendSequenceId(db);
    expect(second).toBe(first);
    const rows = await db.select().from(schema.sequences);
    expect(rows).toHaveLength(1);
  });

  it('the sequence has exactly one step', async () => {
    const id = await getOrCreateManualSendSequenceId(db);
    const rows = await db.select().from(schema.sequences);
    const steps = JSON.parse(rows.find((r) => r.id === id)?.steps ?? '[]');
    expect(steps).toHaveLength(1);
  });
});
