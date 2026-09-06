import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';
import { CompetitorIntelligenceService } from '../../src/competitor/competitor-intelligence-service.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let signals: ContentSignalStore;
let service: CompetitorIntelligenceService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  signals = new ContentSignalStore(db);
  service = new CompetitorIntelligenceService(db);
});

afterEach(() => sqlite.close());

describe('CompetitorIntelligenceService.analyze — themes', () => {
  it('ranks themes by frequency', async () => {
    await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS', accountId: 'a1' });
    await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS', accountId: 'a2' });
    await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC', accountId: 'a1' });

    const report = await service.analyze();
    expect(report.themes[0].painCategory).toBe('ROAS');
    expect(report.themes[0].signalCount).toBe(2);
    expect(report.themes[0].accountCount).toBe(2);
  });

  it('ignores non-competitor signals entirely', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS' });
    const report = await service.analyze();
    expect(report.totalSignals).toBe(0);
  });
});

describe('CompetitorIntelligenceService.analyze — gaps', () => {
  it('identifies a pain category with zero competitor coverage as a gap', async () => {
    await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS', accountId: 'a1' });
    const report = await service.analyze();
    expect(report.gaps).toContain('CAC');
    expect(report.gaps).not.toContain('ROAS');
  });

  it('reports every category as a gap when there are no competitor signals at all', async () => {
    const report = await service.analyze();
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(report.gaps).not.toContain('other');
  });
});
