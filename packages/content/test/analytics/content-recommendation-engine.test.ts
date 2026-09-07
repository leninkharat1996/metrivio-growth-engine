import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, writeAuditLog, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentRecommendationEngine } from '../../src/analytics/content-recommendation-engine.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let engine: ContentRecommendationEngine;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  engine = new ContentRecommendationEngine(db);
});

afterEach(() => sqlite.close());

async function makeOpportunity(pillar: string, score: number, sourceSignalIds: string[] = ['s1']) {
  const id = uuid();
  await db.insert(schema.contentIdeas).values({ id, topic: `${pillar} topic`, source: 'test', whyItMatters: 'matters', hook: 'a hook', recommendedFormat: 'short_post', pillar, status: 'new' });
  await writeAuditLog(db, { actor: 'system', actionType: 'content.opportunity.created', entityType: 'content_opportunity', entityId: id, detail: { score, sourceSignalIds } });
  return id;
}

describe('ContentRecommendationEngine.generateRecommendations', () => {
  it('returns no recommendations when there are no new content ideas', async () => {
    const recs = await engine.generateRecommendations();
    expect(recs).toEqual([]);
  });

  it('produces a recommendation carrying WHAT/WHY/EVIDENCE/FORMAT/HOOK/ICP/PURPOSE for each new idea', async () => {
    await makeOpportunity('attribution', 50);
    const recs = await engine.generateRecommendations();
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(rec.what).toContain('attribution');
    expect(rec.why).toBeTruthy();
    expect(rec.evidence.length).toBeGreaterThan(0);
    expect(rec.format).toBe('short_post');
    expect(rec.hookDirection).toBeTruthy();
    expect(rec.icp).toContain('DTC');
    expect(rec.expectedPurpose).toBeTruthy();
  });

  it('ranks recommendations by score, highest first', async () => {
    await makeOpportunity('CAC', 30);
    await makeOpportunity('ROAS', 80);
    const recs = await engine.generateRecommendations();
    expect(recs[0].what).toContain('ROAS');
  });

  it('boosts a recommendation whose pillar is a competitor topic gap, with evidence naming the gap', async () => {
    const signals = new ContentSignalStore(db);
    for (let i = 0; i < 3; i++) {
      await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'budget_allocation', accountId: `a${i}` });
    }
    await makeOpportunity('budget_allocation', 40);
    const recs = await engine.generateRecommendations();
    expect(recs[0].score).toBeGreaterThan(40);
    expect(recs[0].evidence.some((e) => e.includes('topic gap'))).toBe(true);
  });

  it('preserves traceability back to the source idea and signals', async () => {
    const ideaId = await makeOpportunity('CAC', 50, ['sig-1', 'sig-2']);
    const recs = await engine.generateRecommendations();
    expect(recs[0].sourceIdeaId).toBe(ideaId);
    expect(recs[0].sourceSignalIds).toEqual(['sig-1', 'sig-2']);
  });

  it('never mutates or creates a new content_ideas row (read-only over existing opportunities)', async () => {
    await makeOpportunity('CAC', 50);
    const before = await db.select().from(schema.contentIdeas);
    await engine.generateRecommendations();
    const after = await db.select().from(schema.contentIdeas);
    expect(after.length).toBe(before.length);
  });
});
