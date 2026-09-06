import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';
import { CONTENT_SIGNAL_EXCERPT_MAX_LENGTH } from '../../src/signals/content-signal.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let store: ContentSignalStore;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  store = new ContentSignalStore(db);
});

afterEach(() => sqlite.close());

describe('ContentSignalStore.create', () => {
  it('persists a signal and returns it with a generated id', async () => {
    const signal = await store.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', topic: 'CAC concerns' });
    expect(signal.id).toBeTruthy();
    expect(signal.topic).toBe('CAC concerns');
  });

  it('truncates an excerpt longer than the bound, never storing more', async () => {
    const longText = 'x'.repeat(CONTENT_SIGNAL_EXCERPT_MAX_LENGTH + 100);
    const signal = await store.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', excerpt: longText });
    expect(signal.excerpt?.length).toBe(CONTENT_SIGNAL_EXCERPT_MAX_LENGTH);
  });

  it('preserves the structured extraction object', async () => {
    const signal = await store.create({
      signalType: 'icp_post',
      sourceType: 'x_post',
      confidence: 'INFERENCE',
      extraction: { problem: 'blended ROAS looks fine but margins are shrinking', emotionalIntensity: 'high' },
    });
    expect(signal.extraction?.problem).toContain('blended ROAS');
    expect(signal.extraction?.emotionalIntensity).toBe('high');
  });

  it('preserves engagement metrics', async () => {
    const signal = await store.create({
      signalType: 'expert_post',
      sourceType: 'x_post',
      confidence: 'OBSERVATION',
      engagement: { likes: 120, replies: 15, reposts: 8, bookmarks: 40, views: 5000 },
    });
    expect(signal.engagement).toEqual({ likes: 120, replies: 15, reposts: 8, bookmarks: 40, views: 5000 });
  });

  it('never fabricates a metric it was not given — absent engagement fields stay null', async () => {
    const signal = await store.create({ signalType: 'web_research', sourceType: 'web_article', confidence: 'FACT' });
    expect(signal.engagement.likes).toBeNull();
    expect(signal.engagement.views).toBeNull();
  });
});

describe('ContentSignalStore.get / list', () => {
  it('retrieves a signal by id', async () => {
    const created = await store.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION' });
    const fetched = await store.get(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it('returns null for a missing id', async () => {
    expect(await store.get('no-such-id')).toBeNull();
  });

  it('filters by signalType', async () => {
    await store.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION' });
    await store.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION' });
    const results = await store.list({ signalType: 'competitor_post' });
    expect(results).toHaveLength(1);
    expect(results[0].signalType).toBe('competitor_post');
  });

  it('filters by painCategory', async () => {
    await store.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    await store.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS' });
    const results = await store.list({ painCategory: 'CAC' });
    expect(results).toHaveLength(1);
    expect(results[0].painCategory).toBe('CAC');
  });

  it('respects a limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION' });
    }
    const results = await store.list({ limit: 2 });
    expect(results).toHaveLength(2);
  });
});
