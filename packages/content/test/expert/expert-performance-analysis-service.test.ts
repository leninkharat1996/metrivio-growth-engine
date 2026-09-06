import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MetrivioDb, XReadAdapter, ProfileResult, TweetResult, AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { TrackedAccountStore } from '../../src/accounts/tracked-account-store.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';
import { ExpertPerformanceAnalysisService } from '../../src/expert/expert-performance-analysis-service.js';

class ScriptedXReadAdapter implements XReadAdapter {
  public profile: ProfileResult | Error = { username: 'expert' };
  async getProfile(): Promise<ProfileResult> {
    if (this.profile instanceof Error) throw this.profile;
    return this.profile;
  }
  async searchTweets(): Promise<TweetResult[]> {
    return [];
  }
  async getTweets(): Promise<TweetResult[]> {
    return [];
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
let accounts: TrackedAccountStore;
let signals: ContentSignalStore;
let service: ExpertPerformanceAnalysisService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  accounts = new TrackedAccountStore(db);
  signals = new ContentSignalStore(db);
  service = new ExpertPerformanceAnalysisService(db, adapter);
});

afterEach(() => sqlite.close());

describe('ExpertPerformanceAnalysisService.analyzeAccount — normalized engagement', () => {
  it('computes an engagement rate normalized by follower count when both are available', async () => {
    const account = await accounts.create({ accountType: 'expert', xUsername: 'expert1', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.profile = { username: 'expert1', followerCount: 1000 };
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: account.id, engagement: { likes: 80, replies: 10, reposts: 10 } });

    const result = await service.analyzeAccount(account.id);
    expect(result.engagementRate).toBeCloseTo(100 / 1000, 5);
  });

  it('returns null (never a fabricated number) when no signal carries engagement data', async () => {
    const account = await accounts.create({ accountType: 'expert', xUsername: 'expert2', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.profile = { username: 'expert2', followerCount: 5000 };
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: account.id });

    const result = await service.analyzeAccount(account.id);
    expect(result.engagementRate).toBeNull();
  });

  it('returns null when follower count is unavailable, even with engagement data present', async () => {
    const account = await accounts.create({ accountType: 'expert', xUsername: 'expert3', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.profile = new Error('profile lookup failed');
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: account.id, engagement: { likes: 50 } });

    const result = await service.analyzeAccount(account.id);
    expect(result.followerCount).toBeNull();
    expect(result.engagementRate).toBeNull();
  });

  it('never compares raw engagement counts across accounts of different sizes — only the rate is exposed', async () => {
    const smallAccount = await accounts.create({ accountType: 'expert', xUsername: 'small', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    const bigAccount = await accounts.create({ accountType: 'expert', xUsername: 'big', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: smallAccount.id, engagement: { likes: 50 } });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: bigAccount.id, engagement: { likes: 5000 } });

    adapter.profile = { username: 'small', followerCount: 500 };
    const smallResult = await service.analyzeAccount(smallAccount.id);
    adapter.profile = { username: 'big', followerCount: 50000 };
    const bigResult = await service.analyzeAccount(bigAccount.id);

    // 5000 raw likes >> 50 raw likes, but the NORMALIZED rate is identical (0.1) — proving the metric is audience-size-fair.
    expect(smallResult.engagementRate).toBeCloseTo(bigResult.engagementRate ?? -1, 5);
  });
});

describe('ExpertPerformanceAnalysisService.analyzeAccount — technique extraction', () => {
  it('ranks hook types and pain categories by frequency', async () => {
    const account = await accounts.create({ accountType: 'expert', xUsername: 'expert4', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: account.id, extraction: { hookType: 'question_hook' }, painCategory: 'ROAS' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: account.id, extraction: { hookType: 'question_hook' }, painCategory: 'CAC' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: account.id, extraction: { hookType: 'numbered_hook' }, painCategory: 'ROAS' });

    const result = await service.analyzeAccount(account.id);
    expect(result.topHookTypes[0]).toEqual({ key: 'question_hook', count: 2 });
    expect(result.topPainCategories[0]).toEqual({ key: 'ROAS', count: 2 });
  });

  it('throws for an unknown account id', async () => {
    await expect(service.analyzeAccount('no-such-id')).rejects.toThrow(/no tracked account found/);
  });
});
