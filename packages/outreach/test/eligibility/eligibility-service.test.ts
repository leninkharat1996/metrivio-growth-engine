import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, SystemConfigService, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { OutreachEligibilityService } from '../../src/eligibility/eligibility-service.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let service: OutreachEligibilityService;
let config: SystemConfigService;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  service = new OutreachEligibilityService(db);
  config = new SystemConfigService(db);
  await config.setOutreachMinimumTier('B', 'test');
});

afterEach(() => sqlite.close());

async function insertProspect(overrides: Partial<typeof schema.prospects.$inferInsert> = {}): Promise<string> {
  const id = uuid();
  await db.insert(schema.prospects).values({
    id,
    xUsername: `user-${id.slice(0, 8)}`,
    source: 'founder_search',
    dateDiscovered: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function insertScore(prospectId: string, overrides: Partial<typeof schema.icpScores.$inferInsert> = {}): Promise<void> {
  await db.insert(schema.icpScores).values({
    id: uuid(),
    prospectId,
    score: 90,
    tier: 'A',
    exclusionTriggered: false,
    revenueDisclosureStatus: 'UNKNOWN',
    spendDisclosureStatus: 'UNKNOWN',
    scoringEngineVersion: 'icp-scorer-v1',
    ...overrides,
  });
}

async function insertEvidence(prospectId: string): Promise<void> {
  await db.insert(schema.evidence).values({
    id: uuid(),
    prospectId,
    evidenceType: 'decision_maker_signal',
    signalCategory: 'role_founder_or_ceo',
    evidenceTier: 'LIKELY',
    rawValue: 'Founder',
    capturedAt: new Date().toISOString(),
    capturedBy: 'system',
  });
}

describe('OutreachEligibilityService.evaluate', () => {
  it('reads real prospect/icp_scores/evidence rows and returns ELIGIBLE for a qualifying prospect', async () => {
    const prospectId = await insertProspect();
    await insertScore(prospectId);
    await insertEvidence(prospectId);

    const result = await service.evaluate(prospectId);
    expect(result.status).toBe('ELIGIBLE');
  });

  it('returns UNKNOWN when no icp_scores row exists', async () => {
    const prospectId = await insertProspect();
    const result = await service.evaluate(prospectId);
    expect(result.status).toBe('UNKNOWN');
  });

  it('returns BLOCKED when the kill switch is active', async () => {
    const prospectId = await insertProspect();
    await insertScore(prospectId);
    await insertEvidence(prospectId);
    await config.setKillSwitch(true, 'test');

    const result = await service.evaluate(prospectId);
    expect(result.status).toBe('BLOCKED');
  });

  it('uses the most recent icp_scores row when multiple exist', async () => {
    const prospectId = await insertProspect();
    await insertScore(prospectId, { tier: 'C', score: 65 });
    await new Promise((r) => setTimeout(r, 5));
    await insertScore(prospectId, { tier: 'A', score: 95 });
    await insertEvidence(prospectId);

    const result = await service.evaluate(prospectId);
    expect(result.status).toBe('ELIGIBLE');
  });

  it('pain_signals rows alone satisfy the evidence-presence check', async () => {
    const prospectId = await insertProspect();
    await insertScore(prospectId);
    await db.insert(schema.painSignals).values({
      id: uuid(),
      prospectId,
      signalText: 'Our CAC has been rough lately',
      topic: 'CAC',
      capturedAt: new Date().toISOString(),
    });

    const result = await service.evaluate(prospectId);
    expect(result.status).toBe('ELIGIBLE');
  });

  it('throws for a prospect id that does not exist', async () => {
    await expect(service.evaluate('no-such-prospect')).rejects.toThrow(/no prospect found/);
  });
});
