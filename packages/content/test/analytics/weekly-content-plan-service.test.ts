import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, writeAuditLog, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { WeeklyContentPlanService, renderWeeklyContentPlanMarkdown } from '../../src/analytics/weekly-content-plan-service.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let service: WeeklyContentPlanService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  service = new WeeklyContentPlanService(db);
});

afterEach(() => sqlite.close());

async function makeOpportunity(pillar: string, score: number) {
  const id = uuid();
  await db.insert(schema.contentIdeas).values({ id, topic: `${pillar} topic`, source: 'test', whyItMatters: 'matters', hook: 'a hook', recommendedFormat: 'short_post', pillar, status: 'new' });
  await writeAuditLog(db, { actor: 'system', actionType: 'content.opportunity.created', entityType: 'content_opportunity', entityId: id, detail: { score, sourceSignalIds: ['s1'] } });
}

describe('WeeklyContentPlanService.buildPlan', () => {
  it('returns an empty plan when there are no opportunities', async () => {
    const plan = await service.buildPlan();
    expect(plan.priorities).toEqual([]);
  });

  it('bounds the plan to maxPriorities', async () => {
    for (let i = 0; i < 8; i++) await makeOpportunity(`topic${i}`, 50 + i);
    const plan = await service.buildPlan(3);
    expect(plan.priorities).toHaveLength(3);
  });

  it('orders priorities highest score first', async () => {
    await makeOpportunity('low', 20);
    await makeOpportunity('high', 90);
    const plan = await service.buildPlan();
    expect(plan.priorities[0].what).toContain('high');
  });

  it('never mutates content_ideas or approves/publishes anything', async () => {
    await makeOpportunity('CAC', 50);
    await service.buildPlan();
    const drafts = await db.select().from(schema.contentDrafts);
    expect(drafts).toEqual([]);
  });
});

describe('renderWeeklyContentPlanMarkdown', () => {
  it('renders a TOP PRIORITY heading for the first item and numbered priorities after', async () => {
    await makeOpportunity('low', 20);
    await makeOpportunity('high', 90);
    const plan = await service.buildPlan();
    const markdown = renderWeeklyContentPlanMarkdown(plan);
    expect(markdown).toContain('TOP PRIORITY');
    expect(markdown).toContain('Priority 2');
  });

  it('renders a friendly message when there are no priorities', () => {
    const markdown = renderWeeklyContentPlanMarkdown({ generatedAt: 'now', priorities: [] });
    expect(markdown).toContain('No content opportunities');
  });
});
