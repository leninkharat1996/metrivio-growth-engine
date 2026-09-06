import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { SystemConfigService, type MetrivioDb, type XReadAdapter, type TweetResult, type ProfileResult, type AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { CompetitorDiscoveryService } from '../../src/competitor/competitor-discovery-service.js';
import { TrackedAccountStore } from '../../src/accounts/tracked-account-store.js';

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
let service: CompetitorDiscoveryService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  service = new CompetitorDiscoveryService(db, adapter);
  config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
});

afterEach(() => sqlite.close());

function tweetFrom(username: string): TweetResult {
  return { id: `${username}-1`, authorUsername: username, text: 'we help DTC brands', createdAt: new Date().toISOString(), url: `https://x.com/${username}/status/1` };
}

describe('CompetitorDiscoveryService.discover', () => {
  it('classifies an account as a competitor when its bio matches a required keyword', async () => {
    adapter.searchResults = [tweetFrom('growthconsult')];
    adapter.profiles.set('growthconsult', { username: 'growthconsult', bio: 'Fractional CMO helping DTC brands fix marketing efficiency' });

    const result = await service.discover();
    expect(result.created).toHaveLength(1);
    expect(result.created[0].xUsername).toBe('growthconsult');
    expect(result.created[0].accountType).toBe('competitor');
  });

  it('rejects a generic marketing account with no relevant bio evidence', async () => {
    adapter.searchResults = [tweetFrom('randomguy')];
    adapter.profiles.set('randomguy', { username: 'randomguy', bio: 'I love talking about advertising and memes' });

    const result = await service.discover();
    expect(result.created).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].username).toBe('randomguy');
  });

  it('never classifies purely from appearing in a search result — evidence is always the bio, not the query match', async () => {
    adapter.searchResults = [tweetFrom('justappeared')];
    adapter.profiles.set('justappeared', { username: 'justappeared', bio: '' });
    const result = await service.discover();
    expect(result.created).toHaveLength(0);
  });

  it('reuses an existing tracked account rather than creating a duplicate', async () => {
    const store = new TrackedAccountStore(db);
    await store.create({ accountType: 'competitor', xUsername: 'growthconsult', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });

    adapter.searchResults = [tweetFrom('growthconsult')];
    adapter.profiles.set('growthconsult', { username: 'growthconsult', bio: 'marketing efficiency consultant' });
    const result = await service.discover();
    expect(result.created).toHaveLength(0);
    expect(result.reused).toHaveLength(1);
  });

  it('respects the kill switch — no discovery is attempted', async () => {
    await config.setKillSwitch(true, 'test');
    adapter.searchResults = [tweetFrom('growthconsult')];
    adapter.profiles.set('growthconsult', { username: 'growthconsult', bio: 'marketing efficiency consultant' });
    const result = await service.discover();
    expect(result.created).toHaveLength(0);
  });

  it('deduplicates the same candidate appearing across multiple search results', async () => {
    adapter.searchResults = [tweetFrom('growthconsult'), tweetFrom('growthconsult')];
    adapter.profiles.set('growthconsult', { username: 'growthconsult', bio: 'marketing efficiency consultant' });
    const result = await service.discover();
    expect(result.created).toHaveLength(1);
  });
});
