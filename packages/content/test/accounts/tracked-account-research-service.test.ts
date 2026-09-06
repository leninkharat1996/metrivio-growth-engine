import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { SystemConfigService, type MetrivioDb, type XReadAdapter, type TweetResult, type ProfileResult, type AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { TrackedAccountStore } from '../../src/accounts/tracked-account-store.js';
import { TrackedAccountResearchService } from '../../src/accounts/tracked-account-research-service.js';

class ScriptedXReadAdapter implements XReadAdapter {
  private queue: TweetResult[] | Error = [];
  queueTweets(tweets: TweetResult[]): void {
    this.queue = tweets;
  }
  queueError(err: Error): void {
    this.queue = err;
  }
  async getTweets(): Promise<TweetResult[]> {
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
let service: TrackedAccountResearchService;
let accounts: TrackedAccountStore;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  service = new TrackedAccountResearchService(db, adapter);
  accounts = new TrackedAccountStore(db);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
});

afterEach(() => sqlite.close());

describe('TrackedAccountResearchService.researchAccount — competitor', () => {
  it('captures every fetched post, not just pain-flagged ones', async () => {
    const account = await accounts.create({ accountType: 'competitor', xUsername: 'competitor1', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.queueTweets([
      { id: 't1', authorUsername: 'competitor1', text: 'happy Friday everyone', createdAt: new Date().toISOString(), url: 'https://x.com/c/1' },
      { id: 't2', authorUsername: 'competitor1', text: 'CAC is climbing for most brands', createdAt: new Date().toISOString(), url: 'https://x.com/c/2' },
    ]);

    const signals = await service.researchAccount(account.id);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.signalType === 'competitor_post')).toBe(true);
  });

  it('attaches a hookType extraction to every signal', async () => {
    const account = await accounts.create({ accountType: 'competitor', xUsername: 'competitor2', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.queueTweets([{ id: 't1', authorUsername: 'competitor2', text: '3 reasons your ROAS lies to you', createdAt: new Date().toISOString(), url: 'https://x.com/c/1' }]);
    const signals = await service.researchAccount(account.id);
    expect(signals[0].extraction?.hookType).toBe('numbered_hook');
  });
});

describe('TrackedAccountResearchService.researchAccount — expert', () => {
  it('produces expert_post signals for an expert account', async () => {
    const account = await accounts.create({ accountType: 'expert', xUsername: 'expert1', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.queueTweets([{ id: 't1', authorUsername: 'expert1', text: 'contribution margin matters more than ROAS', createdAt: new Date().toISOString(), url: 'https://x.com/e/1' }]);
    const signals = await service.researchAccount(account.id);
    expect(signals[0].signalType).toBe('expert_post');
  });
});

describe('TrackedAccountResearchService — bounds and safety', () => {
  it('respects maxPosts', async () => {
    const account = await accounts.create({ accountType: 'expert', xUsername: 'expert2', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.queueTweets(Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, authorUsername: 'expert2', text: `post ${i}`, createdAt: new Date().toISOString(), url: `https://x.com/e/${i}` })));
    const signals = await service.researchAccount(account.id, { maxPosts: 3 });
    expect(signals).toHaveLength(3);
  });

  it('returns empty when the kill switch is active', async () => {
    await config.setKillSwitch(true, 'test');
    const account = await accounts.create({ accountType: 'expert', xUsername: 'expert3', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    const signals = await service.researchAccount(account.id);
    expect(signals).toEqual([]);
  });

  it('returns empty on a read failure rather than throwing or fabricating', async () => {
    const account = await accounts.create({ accountType: 'expert', xUsername: 'expert4', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.queueError(new Error('network down'));
    const signals = await service.researchAccount(account.id);
    expect(signals).toEqual([]);
  });

  it('throws for an unknown account id', async () => {
    await expect(service.researchAccount('no-such-id')).rejects.toThrow(/no tracked account found/);
  });
});
