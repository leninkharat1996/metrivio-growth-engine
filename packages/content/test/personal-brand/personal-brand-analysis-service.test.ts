import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MetrivioDb, XReadAdapter, ProfileResult, TweetResult, AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { TrackedAccountStore } from '../../src/accounts/tracked-account-store.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';
import { GrowthTechniqueLibrary } from '../../src/growth-techniques/growth-technique-library.js';
import { PersonalBrandAnalysisService } from '../../src/personal-brand/personal-brand-analysis-service.js';

class ScriptedXReadAdapter implements XReadAdapter {
  public profile: ProfileResult = { username: 'expert' };
  async getProfile(): Promise<ProfileResult> {
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
let library: GrowthTechniqueLibrary;
let service: PersonalBrandAnalysisService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  accounts = new TrackedAccountStore(db);
  signals = new ContentSignalStore(db);
  library = new GrowthTechniqueLibrary(db);
  service = new PersonalBrandAnalysisService(db, adapter);
});

afterEach(() => sqlite.close());

describe('PersonalBrandAnalysisService.analyzeAndRecordTechniques', () => {
  it('aggregates hook usage across multiple expert accounts into one technique entry per hook shape', async () => {
    const e1 = await accounts.create({ accountType: 'expert', xUsername: 'e1', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    const e2 = await accounts.create({ accountType: 'expert', xUsername: 'e2', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: e1.id, extraction: { hookType: 'question_hook' } });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: e2.id, extraction: { hookType: 'question_hook' } });

    const techniques = await service.analyzeAndRecordTechniques();
    const questionHookTechnique = techniques.find((t) => t.technique.includes('question'));
    expect(questionHookTechnique).toBeTruthy();
    expect(questionHookTechnique?.evidence).toContain('2 time(s)');
  });

  it('never attributes a technique to one specific named account', async () => {
    const e1 = await accounts.create({ accountType: 'expert', xUsername: 'someinfluencer', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: e1.id, extraction: { hookType: 'contrarian_hook' } });

    const techniques = await service.analyzeAndRecordTechniques();
    for (const t of techniques) {
      expect(t.exampleReference).not.toContain('someinfluencer');
      expect(t.technique).not.toContain('someinfluencer');
    }
  });

  it('describes applicability as mechanics, never voice/personality', async () => {
    const e1 = await accounts.create({ accountType: 'expert', xUsername: 'e1', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: e1.id, extraction: { hookType: 'numbered_hook' } });

    const techniques = await service.analyzeAndRecordTechniques();
    const numbered = techniques.find((t) => t.technique.includes('numbered'));
    expect(numbered?.applicability.toLowerCase()).not.toContain('personality');
    expect(numbered?.applicability.toLowerCase()).not.toContain('voice');
  });

  it('persists recorded techniques into the growth technique library', async () => {
    const e1 = await accounts.create({ accountType: 'expert', xUsername: 'e1', classificationReason: 'seed', classificationConfidence: 'OBSERVATION' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', accountId: e1.id, extraction: { hookType: 'statement_hook' } });

    await service.analyzeAndRecordTechniques();
    const stored = await library.list({ category: 'hook' });
    expect(stored.length).toBeGreaterThan(0);
  });

  it('returns an empty list when there are no tracked expert accounts', async () => {
    const techniques = await service.analyzeAndRecordTechniques();
    expect(techniques).toEqual([]);
  });
});
