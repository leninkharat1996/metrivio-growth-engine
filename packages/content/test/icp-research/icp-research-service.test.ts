import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb, type XReadAdapter, type TweetResult, type ProfileResult, type AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { IcpResearchService } from '../../src/icp-research/icp-research-service.js';

class ScriptedXReadAdapter implements XReadAdapter {
  public calls: string[] = [];
  private queue: TweetResult[] | Error = [];
  queueTweets(tweets: TweetResult[]): void {
    this.queue = tweets;
  }
  queueError(err: Error): void {
    this.queue = err;
  }
  async getTweets(handle: string): Promise<TweetResult[]> {
    this.calls.push(handle);
    if (this.queue instanceof Error) throw this.queue;
    return this.queue;
  }
  async searchTweets(): Promise<TweetResult[]> {
    return [];
  }
  async getProfile(): Promise<ProfileResult> {
    return { username: 'x' };
  }
  async getFollowers(): Promise<AccountResult[]> {
    return [];
  }
  async getFollowing(): Promise<AccountResult[]> {
    return [];
  }
  async getListMembers(): Promise<AccountResult[]> {
    return [];
  }
  async getEngagers(): Promise<AccountResult[]> {
    return [];
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let adapter: ScriptedXReadAdapter;
let service: IcpResearchService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  service = new IcpResearchService(db, adapter);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
});

afterEach(() => sqlite.close());

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({
    id,
    xUsername: `founder-${id.slice(0, 8)}`,
    companyName: 'Acme',
    source: 'founder_search',
    dateDiscovered: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

function tweet(overrides: Partial<TweetResult> = {}): TweetResult {
  return { id: uuid(), authorUsername: 'founder', text: 'hello', createdAt: new Date().toISOString(), url: 'https://x.com/founder/status/1', ...overrides };
}

describe('IcpResearchService.researchProspect — founder/growth-leader posts', () => {
  it('identifies a founder post about a pain category and creates a signal', async () => {
    const prospectId = await insertProspect();
    adapter.queueTweets([tweet({ text: 'our CAC has crept up every month this year' })]);

    const signals = await service.researchProspect(prospectId);
    expect(signals).toHaveLength(1);
    expect(signals[0].painCategory).toBe('CAC');
    expect(signals[0].prospectId).toBe(prospectId);
  });

  it('reuses the prospects own x_username identifier rather than re-discovering it', async () => {
    const prospectId = await insertProspect({ xUsername: 'known-handle' });
    adapter.queueTweets([]);
    await service.researchProspect(prospectId);
    expect(adapter.calls).toEqual(['known-handle']);
  });

  it('rejects an irrelevant post (no pain signal, no question, no frustration language)', async () => {
    const prospectId = await insertProspect();
    adapter.queueTweets([tweet({ text: 'excited to announce our new office space' })]);
    const signals = await service.researchProspect(prospectId);
    expect(signals).toHaveLength(0);
  });

  it('captures a question as relevant even without a named pain category', async () => {
    const prospectId = await insertProspect();
    adapter.queueTweets([tweet({ text: 'anyone have a recommendation for a good agency?' })]);
    const signals = await service.researchProspect(prospectId);
    expect(signals).toHaveLength(1);
  });

  it('preserves provenance — source URL and published date', async () => {
    const prospectId = await insertProspect();
    adapter.queueTweets([tweet({ text: 'ROAS is misleading me lately', url: 'https://x.com/founder/status/42', createdAt: '2026-01-01T00:00:00.000Z' })]);
    const signals = await service.researchProspect(prospectId);
    expect(signals[0].sourceUrl).toBe('https://x.com/founder/status/42');
    expect(signals[0].publishedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never claims FACT confidence for a single social post', async () => {
    const prospectId = await insertProspect();
    adapter.queueTweets([tweet({ text: 'attribution is broken for us right now' })]);
    const signals = await service.researchProspect(prospectId);
    expect(signals[0].confidence).toBe('OBSERVATION');
  });
});

describe('IcpResearchService — bounds and safety', () => {
  it('respects maxPosts', async () => {
    const prospectId = await insertProspect();
    adapter.queueTweets(Array.from({ length: 10 }, (_, i) => tweet({ id: `t${i}`, text: `CAC problem number ${i}` })));
    const signals = await service.researchProspect(prospectId, { maxPosts: 3 });
    expect(signals).toHaveLength(3);
  });

  it('returns empty and never calls the adapter when the kill switch is active', async () => {
    await config.setKillSwitch(true, 'test');
    const prospectId = await insertProspect();
    const signals = await service.researchProspect(prospectId);
    expect(signals).toEqual([]);
    expect(adapter.calls).toHaveLength(0);
  });

  it('a read failure returns an empty list rather than throwing or fabricating a result', async () => {
    const prospectId = await insertProspect();
    adapter.queueError(new Error('network down'));
    const signals = await service.researchProspect(prospectId);
    expect(signals).toEqual([]);
  });

  it('throws for a nonexistent prospect id', async () => {
    await expect(service.researchProspect('no-such-id')).rejects.toThrow(/no prospect found/);
  });
});
