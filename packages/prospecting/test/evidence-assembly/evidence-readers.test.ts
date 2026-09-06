import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { readXEvidenceFacts, readTriggerFacts, readTechnologyEvidenceFacts } from '../../src/evidence-assembly/evidence-readers.js';

let db: MetrivioDb;
let sqlite: Database.Database;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
});

afterEach(() => sqlite.close());

async function insertEvidence(prospectId: string, overrides: Partial<typeof schema.evidence.$inferInsert>): Promise<void> {
  await db.insert(schema.evidence).values({
    id: uuid(),
    prospectId,
    evidenceType: 'decision_maker_signal',
    signalCategory: 'role_founder_or_ceo',
    evidenceTier: 'LIKELY',
    rawValue: 'test',
    capturedAt: new Date().toISOString(),
    capturedBy: 'system',
    ...overrides,
  });
}

describe('readXEvidenceFacts', () => {
  it('maps decision_maker_signal / paid_acquisition_signal / revenue_signal / maturity_signal / dtc_signal rows to EvidenceFact[]', async () => {
    const prospectId = 'p1';
    await insertEvidence(prospectId, { evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo' });
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'paid_media_job_posting_90d' });
    const facts = await readXEvidenceFacts(db, prospectId);
    expect(facts).toContainEqual({ evidenceType: 'decision_maker_signal', signalCategory: 'role_founder_or_ceo' });
    expect(facts).toContainEqual({ evidenceType: 'paid_acquisition_signal', signalCategory: 'paid_media_job_posting_90d' });
  });

  it('excludes company_identification rows (not one of Stage 3s five scored evidence types)', async () => {
    const prospectId = 'p2';
    await insertEvidence(prospectId, { evidenceType: 'company_identification', signalCategory: 'website_domain', rawValue: 'example.com' });
    const facts = await readXEvidenceFacts(db, prospectId);
    expect(facts).toHaveLength(0);
  });

  it('excludes trigger_signal rows (handled separately by readTriggerFacts)', async () => {
    const prospectId = 'p3';
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'new_product_launch', sourceUrl: 'https://x.com/a/status/1' });
    const facts = await readXEvidenceFacts(db, prospectId);
    expect(facts).toHaveLength(0);
  });

  it('excludes pain_signal-typed evidence rows (pain signals live in the pain_signals table, not scored facts)', async () => {
    const prospectId = 'p4';
    await insertEvidence(prospectId, { evidenceType: 'pain_signal', signalCategory: 'CAC' });
    const facts = await readXEvidenceFacts(db, prospectId);
    expect(facts).toHaveLength(0);
  });

  it('drops the rows own evidence_tier column — never passes it through as part of the fact', async () => {
    const prospectId = 'p5';
    await insertEvidence(prospectId, { evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d', evidenceTier: 'CONFIRMED' });
    const facts = await readXEvidenceFacts(db, prospectId);
    expect(facts[0]).toEqual({ evidenceType: 'paid_acquisition_signal', signalCategory: 'meta_ad_active_30d' });
    expect(facts[0]).not.toHaveProperty('evidenceTier');
  });

  it('an unresolved/empty prospect (no evidence rows) returns an empty array', async () => {
    const facts = await readXEvidenceFacts(db, 'no-such-prospect');
    expect(facts).toEqual([]);
  });
});

describe('readTriggerFacts', () => {
  it('converts a sourced, valid-type trigger_signal row into a TriggerFact', async () => {
    const prospectId = 'p6';
    await insertEvidence(prospectId, {
      evidenceType: 'trigger_signal',
      signalCategory: 'funding_growth_announcement',
      sourceUrl: 'https://x.com/a/status/1',
    });
    const triggers = await readTriggerFacts(db, prospectId);
    expect(triggers).toEqual([{ triggerType: 'funding_growth_announcement', sourceUrl: 'https://x.com/a/status/1' }]);
  });

  it('a trigger_signal row with no source URL is never converted (ICP §22.B requires a specific URL/reference)', async () => {
    const prospectId = 'p7';
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'funding_growth_announcement', sourceUrl: null });
    const triggers = await readTriggerFacts(db, prospectId);
    expect(triggers).toHaveLength(0);
  });

  it('an unrecognized signal category is never converted, even with a source URL', async () => {
    const prospectId = 'p8';
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'ad_volume_increase', sourceUrl: 'https://x.com/a/status/1' });
    const triggers = await readTriggerFacts(db, prospectId);
    expect(triggers).toHaveLength(0);
  });

  it('new_paid_channel_appearing is never converted from a single row — the required prior-dated-absence half cannot be represented', async () => {
    const prospectId = 'p9';
    await insertEvidence(prospectId, { evidenceType: 'trigger_signal', signalCategory: 'new_paid_channel_appearing', sourceUrl: 'https://x.com/a/status/1' });
    const triggers = await readTriggerFacts(db, prospectId);
    expect(triggers).toHaveLength(0);
  });

  it('no trigger_signal rows at all returns an empty array (the correct current-state default)', async () => {
    const triggers = await readTriggerFacts(db, 'no-such-prospect');
    expect(triggers).toEqual([]);
  });
});

describe('readTechnologyEvidenceFacts', () => {
  async function seedScan(companyDomain: string, scanStatus: 'OK' | 'BLOCKED' | 'ERROR' | 'INCONCLUSIVE', technologies: Array<{ name: string; status: 'DETECTED' | 'NOT_DETECTED' }>): Promise<void> {
    const scanId = uuid();
    await db.insert(schema.technologyScans).values({
      id: scanId,
      companyDomain,
      scanStatus,
      detector: 'open_tech_analyzer',
      renderUsed: true,
      crawlUsed: 5,
      scannedAt: new Date().toISOString(),
    });
    if (scanStatus === 'OK') {
      for (const tech of technologies) {
        await db.insert(schema.technologyDetections).values({
          id: uuid(),
          scanId,
          technologyName: tech.name,
          status: tech.status,
          confidence: tech.status === 'DETECTED' ? 90 : 0,
          evidence: '[]',
        });
      }
    }
  }

  it('2+ retention tools detected maps to maturity_signal.two_or_more_retention_tools', async () => {
    await seedScan('store.com', 'OK', [
      { name: 'Klaviyo', status: 'DETECTED' },
      { name: 'Gorgias', status: 'DETECTED' },
    ]);
    const facts = await readTechnologyEvidenceFacts(db, 'store.com');
    expect(facts).toContainEqual({ evidenceType: 'maturity_signal', signalCategory: 'two_or_more_retention_tools' });
  });

  it('only 1 retention tool detected does NOT map (threshold fixed at 2)', async () => {
    await seedScan('store.com', 'OK', [{ name: 'Klaviyo', status: 'DETECTED' }]);
    const facts = await readTechnologyEvidenceFacts(db, 'store.com');
    expect(facts.find((f) => f.signalCategory === 'two_or_more_retention_tools')).toBeUndefined();
  });

  it('at least 1 analytics tag detected maps to maturity_signal.analytics_tag_detected', async () => {
    await seedScan('store.com', 'OK', [{ name: 'GA4', status: 'DETECTED' }]);
    const facts = await readTechnologyEvidenceFacts(db, 'store.com');
    expect(facts).toContainEqual({ evidenceType: 'maturity_signal', signalCategory: 'analytics_tag_detected' });
  });

  it('Shopify detected does NOT map to revenue_signal.shopify_plus_detected (Shopify Plus is not an independently confirmed fingerprint)', async () => {
    await seedScan('store.com', 'OK', [{ name: 'Shopify', status: 'DETECTED' }]);
    const facts = await readTechnologyEvidenceFacts(db, 'store.com');
    expect(facts.some((f) => f.evidenceType === 'revenue_signal')).toBe(false);
  });

  it('Meta Pixel detected never maps to paid_acquisition_signal (a tracking pixel is not ad-spend activity)', async () => {
    await seedScan('store.com', 'OK', [{ name: 'Meta Pixel', status: 'DETECTED' }]);
    const facts = await readTechnologyEvidenceFacts(db, 'store.com');
    expect(facts.some((f) => f.evidenceType === 'paid_acquisition_signal')).toBe(false);
  });

  it('a BLOCKED scan produces zero facts, never a false negative treated as evidence', async () => {
    await seedScan('blocked.com', 'BLOCKED', []);
    const facts = await readTechnologyEvidenceFacts(db, 'blocked.com');
    expect(facts).toHaveLength(0);
  });

  it('an ERROR scan produces zero facts', async () => {
    await seedScan('erroring.com', 'ERROR', []);
    const facts = await readTechnologyEvidenceFacts(db, 'erroring.com');
    expect(facts).toHaveLength(0);
  });

  it('an INCONCLUSIVE scan produces zero facts', async () => {
    await seedScan('inconclusive.com', 'INCONCLUSIVE', []);
    const facts = await readTechnologyEvidenceFacts(db, 'inconclusive.com');
    expect(facts).toHaveLength(0);
  });

  it('no scan at all for the domain produces zero facts', async () => {
    const facts = await readTechnologyEvidenceFacts(db, 'never-scanned.com');
    expect(facts).toHaveLength(0);
  });
});
