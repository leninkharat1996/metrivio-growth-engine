import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '@metrivio/core';
import { ContentSignalStore, OwnContentPerformanceService, GrowthTechniqueLibrary } from '@metrivio/content';
import { createTestDb } from './helpers/test-db.js';
import { DashboardDataService } from '../src/dashboard-data-service.js';
import { renderDashboardHtml } from '../src/dashboard-html-renderer.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let service: DashboardDataService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  service = new DashboardDataService(db);
});

afterEach(() => sqlite.close());

describe('DashboardDataService.build — empty state', () => {
  it('never throws and returns empty-but-valid arrays when there is no data yet', async () => {
    const data = await service.build();
    expect(data.icpPainTrends).toEqual([]);
    expect(data.ownPostPerformance).toEqual([]);
    expect(data.growthTechniques).toEqual([]);
    expect(data.recommendedNextContent).toEqual([]);
  });
});

describe('DashboardDataService.build — correct aggregation', () => {
  it('surfaces ICP pain trends', async () => {
    const signals = new ContentSignalStore(db);
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    const data = await service.build();
    expect(data.icpPainTrends.some((t) => t.painCategory === 'CAC')).toBe(true);
  });

  it('derives best-performing topics/hooks from ranked own-post performance, never inventing a new metric', async () => {
    const performance = new OwnContentPerformanceService(db);
    await performance.ingestSnapshot({ postId: 'p1', text: 'why CAC keeps climbing', likes: 10, icpEngagementCount: 2 });
    const data = await service.build();
    expect(data.bestPerformingTopics).toContain('CAC');
  });

  it('includes growth techniques recorded in the library', async () => {
    const library = new GrowthTechniqueLibrary(db);
    await library.record({ technique: 'numbered hook', category: 'hook', evidence: 'e', applicability: 'a', status: 'LIKELY' });
    const data = await service.build();
    expect(data.growthTechniques).toHaveLength(1);
  });

  it('never invents a metric that was not ingested', async () => {
    const performance = new OwnContentPerformanceService(db);
    await performance.ingestSnapshot({ postId: 'p1' });
    const data = await service.build();
    expect(data.ownPostPerformance[0].reach).toBeNull();
  });
});

describe('renderDashboardHtml', () => {
  it('renders all 9 sections even with empty data', async () => {
    const data = await service.build();
    const html = renderDashboardHtml(data);
    for (let i = 1; i <= 9; i++) expect(html).toContain(`>${i}.`);
  });

  it('escapes HTML-unsafe characters in rendered content', async () => {
    const library = new GrowthTechniqueLibrary(db);
    await library.record({ technique: '<script>alert(1)</script>', category: 'hook', evidence: 'e', applicability: 'a', status: 'LIKELY' });
    const data = await service.build();
    const html = renderDashboardHtml(data);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never renders a publishing/send control', async () => {
    const data = await service.build();
    const html = renderDashboardHtml(data);
    expect(html.toLowerCase()).not.toContain('<button');
    expect(html.toLowerCase()).not.toContain('<form');
  });
});
