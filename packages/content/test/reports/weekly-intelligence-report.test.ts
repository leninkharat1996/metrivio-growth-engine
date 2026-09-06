import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';
import { WeeklyIntelligenceReportService, renderWeeklyReportMarkdown } from '../../src/reports/weekly-intelligence-report.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let signals: ContentSignalStore;
let service: WeeklyIntelligenceReportService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  signals = new ContentSignalStore(db);
  service = new WeeklyIntelligenceReportService(db);
});

afterEach(() => sqlite.close());

describe('WeeklyIntelligenceReportService.generate', () => {
  it('produces empty-but-valid sections when no data has been collected yet', async () => {
    const report = await service.generate();
    expect(report.topIcpProblems).toEqual([]);
    expect(report.recommendedPosts).toEqual([]);
  });

  it('surfaces top ICP problems ranked by frequency', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS' });

    const report = await service.generate();
    expect(report.topIcpProblems[0]).toEqual({ painCategory: 'CAC', count: 2 });
  });

  it('separates emerging (recent) pain points from all-time top problems', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC', publishedAt: '2020-01-01T00:00:00.000Z' });
    const report = await service.generate('2026-01-01T00:00:00.000Z');
    expect(report.topIcpProblems.some((t) => t.painCategory === 'CAC')).toBe(true);
    expect(report.emergingPainPoints.some((t) => t.painCategory === 'CAC')).toBe(false);
  });

  it('includes competitor themes and gaps', async () => {
    await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS', accountId: 'a1' });
    const report = await service.generate();
    expect(report.topCompetitorThemes.some((t) => t.painCategory === 'ROAS')).toBe(true);
    expect(report.competitorGaps).toContain('CAC');
  });

  it('recommends up to 5 posts, each with a stated reason', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'FACT', painCategory: 'CAC' });
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'FACT', painCategory: 'ROAS' });
    const report = await service.generate();
    expect(report.recommendedPosts.length).toBeLessThanOrEqual(5);
    expect(report.whySelected).toHaveLength(report.recommendedPosts.length);
    expect(report.whySelected[0]).toContain('score');
  });

  it('is deterministic given the same signals and the same "now"', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    const a = await service.generate('2026-01-01T00:00:00.000Z');
    const b = await service.generate('2026-01-01T00:00:00.000Z');
    expect(a.topIcpProblems).toEqual(b.topIcpProblems);
    expect(a.recommendedPosts.map((p) => p.score)).toEqual(b.recommendedPosts.map((p) => p.score));
  });
});

describe('renderWeeklyReportMarkdown', () => {
  it('renders all 9 sections', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    const report = await service.generate();
    const markdown = renderWeeklyReportMarkdown(report);
    for (let i = 1; i <= 9; i++) expect(markdown).toContain(`## ${i}.`);
  });

  it('never crashes on an empty report', async () => {
    const report = await service.generate();
    expect(() => renderWeeklyReportMarkdown(report)).not.toThrow();
  });
});
