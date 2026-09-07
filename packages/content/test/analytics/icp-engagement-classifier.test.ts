import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { IcpEngagementClassifier } from '../../src/analytics/icp-engagement-classifier.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let classifier: IcpEngagementClassifier;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  classifier = new IcpEngagementClassifier(db);
});

afterEach(() => sqlite.close());

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}) {
  const id = uuid();
  await db.insert(schema.prospects).values({
    id,
    xUsername: 'founder_jane',
    xUserId: 'u123',
    source: 'content_engagement',
    dateDiscovered: new Date().toISOString(),
    roleTitle: 'Founder',
    companyName: 'Acme DTC',
    ...overrides,
  });
  return id;
}

describe('IcpEngagementClassifier.classifyEngager — known identity', () => {
  it('classifies ICP_ENGAGEMENT when the engager matches an existing prospect by X user id', async () => {
    await insertProspect();
    const result = await classifier.classifyEngager({ username: 'founder_jane', userId: 'u123' });
    expect(result.classification).toBe('ICP_ENGAGEMENT');
    expect(result.roleTitle).toBe('Founder');
    expect(result.companyName).toBe('Acme DTC');
  });

  it('classifies ICP_ENGAGEMENT when matched by username (case-insensitive), with no user id available', async () => {
    await insertProspect({ xUsername: 'Founder_Jane' });
    const result = await classifier.classifyEngager({ username: 'founder_jane' });
    expect(result.classification).toBe('ICP_ENGAGEMENT');
  });

  it('prefers a user-id match over a username match when both are present', async () => {
    const id = await insertProspect({ xUserId: 'exact-id' });
    const result = await classifier.classifyEngager({ username: 'founder_jane', userId: 'exact-id' });
    expect(result.matchedProspectId).toBe(id);
  });
});

describe('IcpEngagementClassifier.classifyEngager — unknown identity', () => {
  it('returns UNKNOWN when no prospect matches the user id or username', async () => {
    const result = await classifier.classifyEngager({ username: 'random_person', userId: 'no-such-id' });
    expect(result.classification).toBe('UNKNOWN');
    expect(result.matchedProspectId).toBeUndefined();
  });

  it('returns UNKNOWN for an empty username with no user id', async () => {
    const result = await classifier.classifyEngager({ username: '' });
    expect(result.classification).toBe('UNKNOWN');
  });

  it('never infers ICP status from a username alone without a prospects match, even if it looks founder-like', async () => {
    const result = await classifier.classifyEngager({ username: 'definitely_a_ceo_founder' });
    expect(result.classification).toBe('UNKNOWN');
  });
});
