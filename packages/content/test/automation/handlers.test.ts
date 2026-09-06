import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MetrivioDb, XReadAdapter, TweetResult, ProfileResult, AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';
import { TrackedAccountStore } from '../../src/accounts/tracked-account-store.js';
import { TrackedAccountResearchService } from '../../src/accounts/tracked-account-research-service.js';
import { PersonalBrandAnalysisService } from '../../src/personal-brand/personal-brand-analysis-service.js';
import { AnalyzeIcpConversationsHandler } from '../../src/automation/analyze-icp-conversations-handler.js';
import { AnalyzeCompetitorContentHandler } from '../../src/automation/analyze-competitor-content-handler.js';
import { AnalyzeExpertContentHandler } from '../../src/automation/analyze-expert-content-handler.js';

class ScriptedXReadAdapter implements XReadAdapter {
  private queue: Array<TweetResult[] | Error> = [];
  queueTweets(t: TweetResult[]): void {
    this.queue.push(t);
  }
  queueError(err: Error): void {
    this.queue.push(err);
  }
  async getTweets(): Promise<TweetResult[]> {
    const next = this.queue.shift();
    if (next === undefined) return [];
    if (next instanceof Error) throw next;
    return next;
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
let signals: ContentSignalStore;
let accounts: TrackedAccountStore;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  signals = new ContentSignalStore(db);
  accounts = new TrackedAccountStore(db);
});

afterEach(() => sqlite.close());

function ctx(overrides: Partial<{ maxItems: number }> = {}) {
  return { runId: 'run-1', dryRun: false, maxItems: overrides.maxItems ?? 25, checkpoint: null, updateCheckpoint: async () => undefined };
}

describe('AnalyzeIcpConversationsHandler', () => {
  it('aggregates by pain category without any new network I/O', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    const handler = new AnalyzeIcpConversationsHandler(db, signals);
    const result = await handler.run(ctx());
    expect(result.itemsProcessed).toBe(2);
    expect((result.detail?.byCategory as Record<string, number>).CAC).toBe(2);
  });
});

describe('AnalyzeCompetitorContentHandler — failure isolation', () => {
  it('one failing competitor account does not stop the others', async () => {
    const a = await accounts.create({ accountType: 'competitor', xUsername: 'a', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    const b = await accounts.create({ accountType: 'competitor', xUsername: 'b', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.queueError(new Error('network down'));
    adapter.queueTweets([{ id: 't1', authorUsername: 'b', text: 'hello', createdAt: new Date().toISOString(), url: 'https://x.com/1' }]);

    const research = new TrackedAccountResearchService(db, adapter);
    const handler = new AnalyzeCompetitorContentHandler(db, accounts, research);
    const result = await handler.run(ctx());
    expect(result.itemsProcessed).toBe(2);
    void a;
    void b;
  });

  it('respects ctx.maxItems', async () => {
    for (let i = 0; i < 4; i++) {
      await accounts.create({ accountType: 'competitor', xUsername: `c${i}`, classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
      adapter.queueTweets([]);
    }
    const research = new TrackedAccountResearchService(db, adapter);
    const handler = new AnalyzeCompetitorContentHandler(db, accounts, research);
    const result = await handler.run(ctx({ maxItems: 2 }));
    expect(result.itemsProcessed).toBe(2);
  });
});

describe('AnalyzeExpertContentHandler', () => {
  it('records growth techniques only after new expert signals were captured', async () => {
    const expert = await accounts.create({ accountType: 'expert', xUsername: 'e1', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.queueTweets([{ id: 't1', authorUsername: 'e1', text: 'contribution margin over ROAS', createdAt: new Date().toISOString(), url: 'https://x.com/1' }]);

    const research = new TrackedAccountResearchService(db, adapter);
    const personalBrand = new PersonalBrandAnalysisService(db, adapter);
    const handler = new AnalyzeExpertContentHandler(db, accounts, research, personalBrand);
    const result = await handler.run(ctx());
    expect(result.detail?.signalsCreated).toBe(1);
    expect((result.detail?.techniquesRecorded as number) > 0).toBe(true);
    void expert;
  });

  it('never records techniques when no new signals were found', async () => {
    await accounts.create({ accountType: 'expert', xUsername: 'e2', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    adapter.queueTweets([]);

    const research = new TrackedAccountResearchService(db, adapter);
    const personalBrand = new PersonalBrandAnalysisService(db, adapter);
    const handler = new AnalyzeExpertContentHandler(db, accounts, research, personalBrand);
    const result = await handler.run(ctx());
    expect(result.detail?.techniquesRecorded).toBe(0);
  });
});
