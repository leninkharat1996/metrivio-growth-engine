import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';
import { OwnContentPerformanceService } from '../../src/own-content/own-content-performance-service.js';
import { BenchmarkingService } from '../../src/analytics/benchmarking-service.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let signals: ContentSignalStore;
let performance: OwnContentPerformanceService;
let benchmarking: BenchmarkingService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  signals = new ContentSignalStore(db);
  performance = new OwnContentPerformanceService(db);
  benchmarking = new BenchmarkingService(db);
});

afterEach(() => sqlite.close());

describe('BenchmarkingService.analyze — topic gaps', () => {
  it('identifies a pain category competitors cover that Metrivio has never posted about', async () => {
    for (let i = 0; i < 3; i++) {
      await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'attribution', accountId: `acct${i}` });
    }
    const report = await benchmarking.analyze();
    expect(report.topicGaps.some((g) => g.painCategory === 'attribution')).toBe(true);
  });

  it('never reports a topic as a gap when Metrivio has already posted about it', async () => {
    for (let i = 0; i < 3; i++) {
      await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'attribution', accountId: `acct${i}` });
    }
    const ideaId = uuid();
    await db.insert(schema.contentIdeas).values({ id: ideaId, topic: 'attribution', source: 'test', recommendedFormat: 'short_post', pillar: 'attribution' });
    const draftId = uuid();
    await db.insert(schema.contentDrafts).values({ id: draftId, ideaId, body: 'body', qualityCheckStatus: 'pass', approvalStatus: 'approved' });
    await performance.ingestSnapshot({ postId: 'p1', draftId, text: 'we cover attribution too', impressions: 100 });

    const report = await benchmarking.analyze();
    expect(report.topicGaps.some((g) => g.painCategory === 'attribution')).toBe(false);
  });
});

describe('BenchmarkingService.analyze — hook pattern gaps', () => {
  it('identifies a hook shape experts use frequently that Metrivio rarely/never uses', async () => {
    for (let i = 0; i < 4; i++) {
      await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', excerpt: '5 mistakes DTC founders make with CAC' });
    }
    const report = await benchmarking.analyze();
    expect(report.hookPatternGaps.some((g) => g.hookType === 'numbered_hook')).toBe(true);
  });

  it('never reports a hook gap when Metrivio already uses it comparably often', async () => {
    for (let i = 0; i < 4; i++) {
      await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', excerpt: '5 mistakes DTC founders make with CAC' });
    }
    const ideaId = uuid();
    await db.insert(schema.contentIdeas).values({ id: ideaId, topic: 'numbered content', source: 'test', recommendedFormat: 'short_post', pillar: 'growth' });
    for (let i = 0; i < 4; i++) {
      const draftId = uuid();
      await db.insert(schema.contentDrafts).values({ id: draftId, ideaId, body: 'body', qualityCheckStatus: 'pass', approvalStatus: 'approved' });
      await performance.ingestSnapshot({ postId: `own${i}`, draftId, text: '3 ways to lower CAC', impressions: 100 });
    }
    const report = await benchmarking.analyze();
    expect(report.hookPatternGaps.some((g) => g.hookType === 'numbered_hook')).toBe(false);
  });
});

describe('BenchmarkingService.analyze — differentiation opportunities (reuses Stage 7 gap detection)', () => {
  it('surfaces pain categories with zero competitor coverage as differentiation opportunities', async () => {
    const report = await benchmarking.analyze();
    expect(report.differentiationOpportunities.length).toBeGreaterThan(0);
  });
});
