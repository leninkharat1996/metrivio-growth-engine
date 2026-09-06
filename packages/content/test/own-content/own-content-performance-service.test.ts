import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { OwnContentPerformanceService } from '../../src/own-content/own-content-performance-service.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let service: OwnContentPerformanceService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  service = new OwnContentPerformanceService(db);
});

afterEach(() => sqlite.close());

describe('OwnContentPerformanceService.ingestSnapshot', () => {
  it('never defaults a missing metric to zero', async () => {
    const snapshot = await service.ingestSnapshot({ postId: 'p1' });
    expect(snapshot.likes).toBeNull();
    expect(snapshot.impressions).toBeNull();
  });

  it('classifies hook type and pain category from provided text', async () => {
    const snapshot = await service.ingestSnapshot({ postId: 'p2', text: '3 reasons your CAC keeps climbing' });
    expect(snapshot.hookType).toBe('numbered_hook');
    expect(snapshot.painCategory).toBe('CAC');
  });

  it('leaves classification null when no text is provided', async () => {
    const snapshot = await service.ingestSnapshot({ postId: 'p3', likes: 10 });
    expect(snapshot.hookType).toBeNull();
    expect(snapshot.painCategory).toBeNull();
  });
});

describe('OwnContentPerformanceService.getLatestSnapshot', () => {
  it('returns the most recently ingested snapshot', async () => {
    await service.ingestSnapshot({ postId: 'p1', likes: 5 });
    await service.ingestSnapshot({ postId: 'p1', likes: 20 });
    const latest = await service.getLatestSnapshot('p1');
    expect(latest?.likes).toBe(20);
  });

  it('returns null for a post with no ingested data', async () => {
    expect(await service.getLatestSnapshot('no-such-post')).toBeNull();
  });
});

describe('OwnContentPerformanceService.analyzeTopPosts — reach vs engagement vs ICP engagement vs business intent', () => {
  it('ranks a lower-reach, ICP-engaged post above a higher-reach, non-ICP post', async () => {
    await service.ingestSnapshot({ postId: 'viral', impressions: 10000, likes: 500, icpEngagementCount: 0 });
    await service.ingestSnapshot({ postId: 'targeted', impressions: 1500, likes: 20, icpEngagementCount: 3 });

    const ranked = await service.analyzeTopPosts(['viral', 'targeted']);
    expect(ranked[0].postId).toBe('targeted');
  });

  it('distinguishes REACH, ENGAGEMENT, ICP_ENGAGEMENT, and BUSINESS_INTENT as separate fields', async () => {
    await service.ingestSnapshot({ postId: 'p1', impressions: 100, likes: 10, replies: 2, reposts: 1, bookmarks: 0, icpEngagementCount: 1 });
    const [summary] = await service.analyzeTopPosts(['p1']);
    expect(summary.reach).toBe(100);
    expect(summary.engagement).toBe(13);
    expect(summary.icpEngagement).toBe(1);
    expect(summary.businessIntentSignal).toBe('present');
  });

  it('reports businessIntentSignal as unknown, never "none", when ICP engagement was never tracked', async () => {
    await service.ingestSnapshot({ postId: 'p1', impressions: 100 });
    const [summary] = await service.analyzeTopPosts(['p1']);
    expect(summary.businessIntentSignal).toBe('unknown');
  });

  it('never fabricates an engagement total when no engagement fields were ever provided', async () => {
    await service.ingestSnapshot({ postId: 'p1', impressions: 100 });
    const [summary] = await service.analyzeTopPosts(['p1']);
    expect(summary.engagement).toBeNull();
  });

  it('skips a postId with no ingested data rather than fabricating a summary', async () => {
    await service.ingestSnapshot({ postId: 'p1', impressions: 100 });
    const ranked = await service.analyzeTopPosts(['p1', 'never-ingested']);
    expect(ranked).toHaveLength(1);
  });
});
