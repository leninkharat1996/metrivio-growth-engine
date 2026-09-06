import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { DraftGenerationService } from '../../src/drafts/draft-generation-service.js';

let db: MetrivioDb;
let sqlite: Database.Database;
let service: DraftGenerationService;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  service = new DraftGenerationService(db);
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

describe('DraftGenerationService.generateDraftForProspect', () => {
  it('reads real evidence/pain_signals/technology rows and produces a draft', async () => {
    const prospectId = await insertProspect({ displayName: 'Jane Founder', companyName: 'Acme', companyDomain: 'acme.com' });
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

    const scanId = uuid();
    await db.insert(schema.technologyScans).values({
      id: scanId,
      companyDomain: 'acme.com',
      scanStatus: 'OK',
      detector: 'open_tech_analyzer',
      scannedAt: new Date().toISOString(),
    });
    await db.insert(schema.technologyDetections).values({
      id: uuid(),
      scanId,
      technologyName: 'Shopify',
      status: 'DETECTED',
      confidence: 90,
      evidence: '[]',
    });

    const { draft } = await service.generateDraftForProspect(prospectId);
    expect(draft.selectedHook).not.toBeNull();
    expect(draft.messageText.length).toBeGreaterThan(0);
  });

  it('handles a prospect with zero evidence and no domain safely', async () => {
    const prospectId = await insertProspect();
    const { draft } = await service.generateDraftForProspect(prospectId);
    expect(draft.selectedHook).toBeNull();
    expect(draft.messageText.length).toBeGreaterThan(0);
  });

  it('ignores technology detections from a BLOCKED/ERROR scan (never a false-positive fact)', async () => {
    const prospectId = await insertProspect({ companyDomain: 'blocked.com' });
    await db.insert(schema.technologyScans).values({
      id: uuid(),
      companyDomain: 'blocked.com',
      scanStatus: 'BLOCKED',
      detector: 'open_tech_analyzer',
      scannedAt: new Date().toISOString(),
    });

    const { draft } = await service.generateDraftForProspect(prospectId);
    expect(draft.selectedHook).toBeNull();
  });

  it('throws for a prospect id that does not exist', async () => {
    await expect(service.generateDraftForProspect('no-such-prospect')).rejects.toThrow(/no prospect found/);
  });

  it('exposes .drafts for direct approval-workflow access after generation', async () => {
    const prospectId = await insertProspect();
    const { draft } = await service.generateDraftForProspect(prospectId);
    const submitted = await service.drafts.submitForApproval(draft.id);
    expect(submitted.status).toBe('PENDING_APPROVAL');
  });
});
