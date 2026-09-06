import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { SystemConfigService, type MetrivioDb, type XReadAdapter, type TweetResult, type ProfileResult, type AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ExpertDiscoveryService } from '../../src/expert/expert-discovery-service.js';

class ScriptedXReadAdapter implements XReadAdapter {
  public profiles = new Map<string, ProfileResult>();
  public searchResults: TweetResult[] = [];
  async searchTweets(): Promise<TweetResult[]> {
    return this.searchResults;
  }
  async getProfile(handle: string): Promise<ProfileResult> {
    const profile = this.profiles.get(handle);
    if (!profile) throw new Error('not found');
    return profile;
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
let service: ExpertDiscoveryService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  service = new ExpertDiscoveryService(db, adapter);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
});

afterEach(() => sqlite.close());

function tweetFrom(username: string): TweetResult {
  return { id: `${username}-1`, authorUsername: username, text: 'thoughts on growth', createdAt: new Date().toISOString(), url: `https://x.com/${username}/status/1` };
}

describe('ExpertDiscoveryService.discover', () => {
  it('classifies an account as an expert when its bio matches a niche keyword', async () => {
    adapter.searchResults = [tweetFrom('growthwriter')];
    adapter.profiles.set('growthwriter', { username: 'growthwriter', bio: 'Writing about DTC growth and paid ads every week' });

    const result = await service.discover();
    expect(result.created).toHaveLength(1);
    expect(result.created[0].accountType).toBe('expert');
  });

  it('rejects an account with an irrelevant bio', async () => {
    adapter.searchResults = [tweetFrom('randomcat')];
    adapter.profiles.set('randomcat', { username: 'randomcat', bio: 'cat photos and travel' });
    const result = await service.discover();
    expect(result.created).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it('respects the kill switch', async () => {
    await config.setKillSwitch(true, 'test');
    adapter.searchResults = [tweetFrom('growthwriter')];
    adapter.profiles.set('growthwriter', { username: 'growthwriter', bio: 'DTC growth' });
    const result = await service.discover();
    expect(result.created).toHaveLength(0);
  });
});
