import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { OwnContentPerformanceService } from '../../src/own-content/own-content-performance-service.js';
import { PerformanceAnalysisService } from '../../src/analytics/performance-analysis-service.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let performance: OwnContentPerformanceService;
let analysis: PerformanceAnalysisService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  performance = new OwnContentPerformanceService(db);
  analysis = new PerformanceAnalysisService(db);
});

afterEach(() => sqlite.close());

async function makeIdeaAndDraft(topic: string, pillar: string, format: 'short_post' | 'thread' = 'short_post') {
  const ideaId = uuid();
  await db.insert(schema.contentIdeas).values({ id: ideaId, topic, source: 'test', recommendedFormat: format, pillar });
  const draftId = uuid();
  await db.insert(schema.contentDrafts).values({ id: draftId, ideaId, body: 'body', qualityCheckStatus: 'pass', approvalStatus: 'approved' });
  return draftId;
}

describe('PerformanceAnalysisService.analyze — grouping', () => {
  it('returns empty groups with no data ingested', async () => {
    const result = await analysis.analyze();
    expect(result.totalPostsAnalyzed).toBe(0);
    expect(result.byTopic).toEqual([]);
    expect(result.overallBaselineScore).toBeNull();
  });

  it('groups posts by topic, pillar, hook type, format, and CTA type', async () => {
    const draftId = await makeIdeaAndDraft('CAC efficiency', 'measurement');
    await performance.ingestSnapshot({ postId: 'p1', draftId, text: 'Is your CAC climbing? Reply below.', impressions: 5000, likes: 50 });

    const result = await analysis.analyze();
    expect(result.byTopic.some((g) => g.value === 'CAC efficiency')).toBe(true);
    expect(result.byPillar.some((g) => g.value === 'measurement')).toBe(true);
    expect(result.byHookType.some((g) => g.value === 'question_hook')).toBe(true);
    expect(result.byFormat.some((g) => g.value === 'short_post')).toBe(true);
    expect(result.byCtaType.some((g) => g.value === 'reply_cta')).toBe(true);
  });

  it('never places a post into a group when the underlying dimension is unavailable', async () => {
    await performance.ingestSnapshot({ postId: 'p2' }); // no text, no draftId at all
    const result = await analysis.analyze();
    expect(result.byTopic).toEqual([]);
    expect(result.byHookType).toEqual([]);
  });
});

describe('PerformanceAnalysisService.analyze — sample-size honesty (Section T)', () => {
  it('reports INSUFFICIENT_DATA pattern strength for a group with 1-2 posts', async () => {
    const draftId1 = await makeIdeaAndDraft('CAC efficiency', 'measurement');
    await performance.ingestSnapshot({ postId: 'p1', draftId: draftId1, text: 'CAC is rising.', impressions: 1000 });

    const result = await analysis.analyze();
    const group = result.byTopic.find((g) => g.value === 'CAC efficiency');
    expect(group?.sampleSize).toBe(1);
    expect(group?.patternStrength).toBe('INSUFFICIENT_DATA');
    expect(group?.performanceDirection).toBe('INSUFFICIENT_DATA');
  });

  it('reports POTENTIAL_PATTERN once a group reaches 3 posts', async () => {
    for (let i = 0; i < 3; i++) {
      const draftId = await makeIdeaAndDraft('ROAS drop', 'measurement');
      await performance.ingestSnapshot({ postId: `p${i}`, draftId, text: 'ROAS keeps dropping.', impressions: 1000 });
    }
    const result = await analysis.analyze();
    const group = result.byTopic.find((g) => g.value === 'ROAS drop');
    expect(group?.sampleSize).toBe(3);
    expect(group?.patternStrength).toBe('POTENTIAL_PATTERN');
  });
});

describe('PerformanceAnalysisService.analyze — value-based ranking, never raw-reach-dominated', () => {
  it('ranks a low-reach, high-ICP-engagement group above a high-reach, zero-ICP group', async () => {
    const highReachDraft = await makeIdeaAndDraft('viral topic', 'awareness');
    for (let i = 0; i < 3; i++) {
      await performance.ingestSnapshot({ postId: `viral${i}`, draftId: highReachDraft, text: 'Huge reach post.', impressions: 100000, likes: 500, icpEngagementCount: 0 });
    }

    const icpDraft = await makeIdeaAndDraft('founder pain', 'measurement');
    for (let i = 0; i < 3; i++) {
      await performance.ingestSnapshot({ postId: `icp${i}`, draftId: icpDraft, text: 'Founder-relevant post.', impressions: 500, icpEngagementCount: 3 });
    }

    const result = await analysis.analyze();
    const viralGroup = result.byTopic.find((g) => g.value === 'viral topic');
    const icpGroup = result.byTopic.find((g) => g.value === 'founder pain');
    expect((icpGroup?.averageContentValueScore ?? 0)).toBeGreaterThan(viralGroup?.averageContentValueScore ?? 0);
  });
});
