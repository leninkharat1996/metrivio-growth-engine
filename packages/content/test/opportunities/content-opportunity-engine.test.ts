import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { ContentSignalStore } from '../../src/signals/content-signal-store.js';
import { ContentOpportunityEngine } from '../../src/opportunities/content-opportunity-engine.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let signals: ContentSignalStore;
let engine: ContentOpportunityEngine;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  signals = new ContentSignalStore(db);
  engine = new ContentOpportunityEngine(db);
});

afterEach(() => sqlite.close());

describe('ContentOpportunityEngine.generateOpportunities — signal to opportunity', () => {
  it('creates an opportunity from a single ICP signal', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    const opportunities = await engine.generateOpportunities();
    expect(opportunities.some((o) => o.painCategory === 'CAC')).toBe(true);
  });

  it('persists a content_ideas row for each opportunity', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'ROAS' });
    await engine.generateOpportunities();
    const rows = await db.select().from(schema.contentIdeas);
    expect(rows.some((r) => r.pillar === 'ROAS')).toBe(true);
    expect(rows[0].status).toBe('new');
  });

  it('combines multiple signals across sources into one richer opportunity', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'attribution' });
    await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'attribution', accountId: 'a1' });
    await signals.create({ signalType: 'expert_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'attribution', accountId: 'a2' });

    const opportunities = await engine.generateOpportunities();
    const attribution = opportunities.find((o) => o.painCategory === 'attribution');
    expect(attribution?.sourceSignalIds).toHaveLength(3);
  });

  it('never creates an opportunity for a category with zero ICP evidence (unsupported opportunity rejected)', async () => {
    await signals.create({ signalType: 'competitor_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'MER', accountId: 'a1' });
    const opportunities = await engine.generateOpportunities();
    expect(opportunities.some((o) => o.painCategory === 'MER')).toBe(false);
  });

  it('never generates an opportunity for the "other" catch-all category', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'other' });
    const opportunities = await engine.generateOpportunities();
    expect(opportunities.some((o) => (o.painCategory as string) === 'other')).toBe(false);
  });
});

describe('ContentOpportunityEngine.generateOpportunities — ranking', () => {
  it('ranks opportunities by score, highest first', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    for (let i = 0; i < 5; i++) {
      await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'FACT', painCategory: 'ROAS' });
    }
    const opportunities = await engine.generateOpportunities();
    const scores = opportunities.map((o) => o.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('respects a minScore filter', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'CAC' });
    const opportunities = await engine.generateOpportunities({ minScore: 1000 });
    expect(opportunities).toHaveLength(0);
  });
});

describe('ContentOpportunityEngine.generateOpportunities — provenance', () => {
  it('records the score breakdown and source signal ids in audit_log', async () => {
    await signals.create({ signalType: 'icp_post', sourceType: 'x_post', confidence: 'OBSERVATION', painCategory: 'profitability' });
    await engine.generateOpportunities();
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actionType, 'content.opportunity.created'));
    expect(rows.length).toBeGreaterThan(0);
    const detail = JSON.parse(rows[0].detail ?? '{}');
    expect(detail.sourceSignalIds).toBeDefined();
    expect(detail.scoreBreakdown).toBeDefined();
  });
});
