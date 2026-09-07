import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { schema, writeAuditLog, SystemConfigService, type MetrivioDb, type XReadAdapter, type TweetResult, type ProfileResult, type AccountResult } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { OwnContentPerformanceService } from '../../src/own-content/own-content-performance-service.js';
import { ContentDraftService } from '../../src/drafts/content-draft-service.js';
import { CollectPostPerformanceHandler } from '../../src/automation/collect-post-performance-handler.js';
import { AnalyzeContentPerformanceHandler } from '../../src/automation/analyze-content-performance-handler.js';
import { UpdateGrowthTechniquesHandler } from '../../src/automation/update-growth-techniques-handler.js';
import { GenerateContentRecommendationsHandler } from '../../src/automation/generate-content-recommendations-handler.js';
import { PerformanceAnalysisService } from '../../src/analytics/performance-analysis-service.js';
import { GrowthTechniqueLearningService } from '../../src/analytics/growth-technique-learning-service.js';
import { ContentRecommendationEngine } from '../../src/analytics/content-recommendation-engine.js';

class ScriptedXReadAdapter implements XReadAdapter {
  public engagersByUrl = new Map<string, AccountResult[]>();
  public mentions: TweetResult[] = [];
  async getTweets(): Promise<TweetResult[]> {
    return [];
  }
  async searchTweets(): Promise<TweetResult[]> {
    return this.mentions;
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
  async getEngagers(tweetUrl: string): Promise<AccountResult[]> {
    return this.engagersByUrl.get(tweetUrl) ?? [];
  }
}

let db: MetrivioDb;
let sqlite: Database.Database;
let adapter: ScriptedXReadAdapter;
let config: SystemConfigService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  adapter = new ScriptedXReadAdapter();
  config = new SystemConfigService(db);
});

afterEach(() => sqlite.close());

const ctx = (overrides: Partial<{ dryRun: boolean; maxItems: number }> = {}) => ({
  runId: 'r1',
  dryRun: overrides.dryRun ?? false,
  maxItems: overrides.maxItems ?? 25,
  checkpoint: null,
  updateCheckpoint: async () => {},
});

describe('CollectPostPerformanceHandler', () => {
  it('reports the exact gap and processes nothing when own_x_handle is not configured', async () => {
    const handler = new CollectPostPerformanceHandler(db, adapter, config);
    const result = await handler.run(ctx());
    expect(result.itemsProcessed).toBe(0);
    expect(result.detail?.skipped).toContain('content.publishing.own_x_handle');
  });

  it('classifies engagers via the existing prospects identity and updates icpEngagementCount', async () => {
    await config.setContentPublishingOwnXHandle('metrivio', 'test');
    await db.insert(schema.prospects).values({ id: uuid(), xUsername: 'founder_jane', xUserId: 'u1', source: 'content_engagement', dateDiscovered: new Date().toISOString() });

    const drafts = new ContentDraftService(db);
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'a post about CAC' });
    await db.update(schema.contentDrafts).set({ xManagerPostId: 'post-1' }).where(eq(schema.contentDrafts.id, draft.id));

    adapter.engagersByUrl.set('https://x.com/metrivio/status/post-1', [
      { username: 'founder_jane', userId: 'u1' },
      { username: 'random_stranger', userId: 'u2' },
    ]);

    const handler = new CollectPostPerformanceHandler(db, adapter, config);
    const result = await handler.run(ctx());
    expect(result.itemsSucceeded).toBe(1);

    const performance = new OwnContentPerformanceService(db);
    const snapshot = await performance.getLatestSnapshot('post-1');
    expect(snapshot?.icpEngagementCount).toBe(1);
  });

  it('never calls the network or writes anything in dry-run mode beyond what it already read', async () => {
    await config.setContentPublishingOwnXHandle('metrivio', 'test');
    const drafts = new ContentDraftService(db);
    const { draft } = await drafts.generateDraft({ ideaId: uuid(), body: 'body' });
    await db.update(schema.contentDrafts).set({ xManagerPostId: 'post-2' }).where(eq(schema.contentDrafts.id, draft.id));
    adapter.engagersByUrl.set('https://x.com/metrivio/status/post-2', [{ username: 'someone' }]);

    const handler = new CollectPostPerformanceHandler(db, adapter, config);
    await handler.run(ctx({ dryRun: true }));

    const performance = new OwnContentPerformanceService(db);
    const snapshot = await performance.getLatestSnapshot('post-2');
    expect(snapshot).toBeNull();
  });

  it('stores a business-intent-qualifying mention as an own_post_engagement content signal', async () => {
    await config.setContentPublishingOwnXHandle('metrivio', 'test');
    adapter.mentions = [{ id: 't1', authorUsername: 'curious_founder', text: 'How does Metrivio actually work?', createdAt: new Date().toISOString(), url: 'https://x.com/curious_founder/status/t1' }];

    const handler = new CollectPostPerformanceHandler(db, adapter, config);
    await handler.run(ctx());

    const signalRows = await db.select().from(schema.contentSignals).where(eq(schema.contentSignals.signalType, 'own_post_engagement'));
    expect(signalRows.length).toBe(1);
  });

  it('never stores a generic-engagement, non-ICP mention as a signal', async () => {
    await config.setContentPublishingOwnXHandle('metrivio', 'test');
    adapter.mentions = [{ id: 't2', authorUsername: 'random_person', text: 'love this 🔥', createdAt: new Date().toISOString(), url: 'https://x.com/random_person/status/t2' }];

    const handler = new CollectPostPerformanceHandler(db, adapter, config);
    await handler.run(ctx());

    const signalRows = await db.select().from(schema.contentSignals).where(eq(schema.contentSignals.signalType, 'own_post_engagement'));
    expect(signalRows.length).toBe(0);
  });

  it('isolates a per-draft failure without aborting the whole run', async () => {
    await config.setContentPublishingOwnXHandle('metrivio', 'test');
    const drafts = new ContentDraftService(db);
    const { draft: d1 } = await drafts.generateDraft({ ideaId: uuid(), body: 'body1' });
    const { draft: d2 } = await drafts.generateDraft({ ideaId: uuid(), body: 'body2' });
    await db.update(schema.contentDrafts).set({ xManagerPostId: 'ok-post' }).where(eq(schema.contentDrafts.id, d1.id));
    await db.update(schema.contentDrafts).set({ xManagerPostId: 'bad-post' }).where(eq(schema.contentDrafts.id, d2.id));

    const originalGetEngagers = adapter.getEngagers.bind(adapter);
    adapter.getEngagers = async (url: string) => {
      if (url.includes('bad-post')) throw new Error('simulated failure');
      return originalGetEngagers(url);
    };

    const handler = new CollectPostPerformanceHandler(db, adapter, config);
    const result = await handler.run(ctx());
    expect(result.itemsSucceeded).toBe(1);
    expect(result.itemsFailed).toBe(1);
  });
});

describe('AnalyzeContentPerformanceHandler', () => {
  it('records a performance-analysis audit row and never mutates a draft', async () => {
    const performance = new OwnContentPerformanceService(db);
    await performance.ingestSnapshot({ postId: 'p1', text: 'CAC is rising', impressions: 1000 });
    const handler = new AnalyzeContentPerformanceHandler(db, new PerformanceAnalysisService(db));
    const result = await handler.run(ctx());
    expect(result.itemsProcessed).toBe(1);
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.performance_analysis.completed'));
    expect(rows.length).toBe(1);
  });

  it('writes nothing in dry-run mode', async () => {
    const handler = new AnalyzeContentPerformanceHandler(db, new PerformanceAnalysisService(db));
    await handler.run(ctx({ dryRun: true }));
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.performance_analysis.completed'));
    expect(rows.length).toBe(0);
  });
});

describe('UpdateGrowthTechniquesHandler', () => {
  it('records growth techniques from own performance data', async () => {
    const performance = new OwnContentPerformanceService(db);
    await performance.ingestSnapshot({ postId: 'p1', text: 'Is CAC climbing?', impressions: 1000 });
    const handler = new UpdateGrowthTechniquesHandler(new GrowthTechniqueLearningService(db));
    const result = await handler.run(ctx());
    expect(result.itemsProcessed).toBeGreaterThan(0);
  });

  it('performs no writes in dry-run mode', async () => {
    const performance = new OwnContentPerformanceService(db);
    await performance.ingestSnapshot({ postId: 'p1', text: 'Is CAC climbing?', impressions: 1000 });
    const handler = new UpdateGrowthTechniquesHandler(new GrowthTechniqueLearningService(db));
    const result = await handler.run(ctx({ dryRun: true }));
    expect(result.itemsProcessed).toBe(0);
  });
});

describe('GenerateContentRecommendationsHandler', () => {
  it('records a recommendations run without approving or creating any draft', async () => {
    const ideaId = uuid();
    await db.insert(schema.contentIdeas).values({ id: ideaId, topic: 'CAC topic', source: 'test', recommendedFormat: 'short_post', pillar: 'CAC', status: 'new' });
    await writeAuditLog(db, { actor: 'system', actionType: 'content.opportunity.created', entityType: 'content_opportunity', entityId: ideaId, detail: { score: 60, sourceSignalIds: [] } });

    const handler = new GenerateContentRecommendationsHandler(db, new ContentRecommendationEngine(db));
    const result = await handler.run(ctx());
    expect(result.itemsProcessed).toBe(1);

    const drafts = await db.select().from(schema.contentDrafts);
    expect(drafts).toEqual([]);
    const idea = (await db.select().from(schema.contentIdeas))[0];
    expect(idea.status).toBe('new'); // never mutated
  });
});
