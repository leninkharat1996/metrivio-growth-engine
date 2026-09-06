import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { schema, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from '../helpers/test-db.js';
import { mineCorrectProfileIdentifiedFromEnrichment } from '../../src/website-evidence/enrichment-mining.js';

let db: MetrivioDb;
let sqlite: Database.Database;

beforeEach(() => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
});

afterEach(() => sqlite.close());

async function seedScan(companyDomain: string, rawResponse: unknown, scanStatus: 'OK' | 'ERROR' = 'OK'): Promise<void> {
  await db.insert(schema.technologyScans).values({
    id: uuid(),
    companyDomain,
    scanStatus,
    detector: 'open_tech_analyzer',
    renderUsed: true,
    crawlUsed: 5,
    rawResponse: JSON.stringify(rawResponse),
    scannedAt: new Date().toISOString(),
  });
}

describe('mineCorrectProfileIdentifiedFromEnrichment', () => {
  it('matches when the scan enrichment lists the prospects exact X handle', async () => {
    await seedScan('store.com', {
      scanStatus: 'OK',
      technologies: [],
      detector: 'open_tech_analyzer',
      timestamp: new Date().toISOString(),
      enrichment: { social: { x: ['https://x.com/JaneFounder'] } },
    });
    const result = await mineCorrectProfileIdentifiedFromEnrichment(db, 'store.com', 'janefounder');
    expect(result.matched).toBe(true);
    expect(result.matchedValue).toBe('https://x.com/JaneFounder');
  });

  it('matches an @-prefixed bare handle form', async () => {
    await seedScan('store.com', {
      scanStatus: 'OK',
      technologies: [],
      detector: 'open_tech_analyzer',
      timestamp: new Date().toISOString(),
      enrichment: { social: { x: ['@janefounder'] } },
    });
    const result = await mineCorrectProfileIdentifiedFromEnrichment(db, 'store.com', 'JaneFounder');
    expect(result.matched).toBe(true);
  });

  it('does not match a different X handle', async () => {
    await seedScan('store.com', {
      scanStatus: 'OK',
      technologies: [],
      detector: 'open_tech_analyzer',
      timestamp: new Date().toISOString(),
      enrichment: { social: { x: ['https://x.com/someoneelse'] } },
    });
    const result = await mineCorrectProfileIdentifiedFromEnrichment(db, 'store.com', 'janefounder');
    expect(result.matched).toBe(false);
  });

  it('returns unmatched when the scan has no enrichment.social.x at all', async () => {
    await seedScan('store.com', {
      scanStatus: 'OK',
      technologies: [],
      detector: 'open_tech_analyzer',
      timestamp: new Date().toISOString(),
    });
    const result = await mineCorrectProfileIdentifiedFromEnrichment(db, 'store.com', 'janefounder');
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/no social\.x entries/);
  });

  it('returns unmatched when no successful scan exists for the domain', async () => {
    const result = await mineCorrectProfileIdentifiedFromEnrichment(db, 'never-scanned.com', 'janefounder');
    expect(result.matched).toBe(false);
    expect(result.scanId).toBeNull();
  });

  it('ignores an ERROR-status scan even if it has a raw_response (never trusts a failed scans payload)', async () => {
    await seedScan(
      'store.com',
      { scanStatus: 'ERROR', technologies: [], detector: 'open_tech_analyzer', timestamp: new Date().toISOString() },
      'ERROR'
    );
    const result = await mineCorrectProfileIdentifiedFromEnrichment(db, 'store.com', 'janefounder');
    expect(result.matched).toBe(false);
    expect(result.scanId).toBeNull();
  });

  it('uses the most recent successful scan when multiple exist', async () => {
    await seedScan('store.com', {
      scanStatus: 'OK',
      technologies: [],
      detector: 'open_tech_analyzer',
      timestamp: new Date().toISOString(),
      enrichment: { social: { x: ['https://x.com/oldhandle'] } },
    });
    await new Promise((r) => setTimeout(r, 5));
    await seedScan('store.com', {
      scanStatus: 'OK',
      technologies: [],
      detector: 'open_tech_analyzer',
      timestamp: new Date().toISOString(),
      enrichment: { social: { x: ['https://x.com/newhandle'] } },
    });
    const result = await mineCorrectProfileIdentifiedFromEnrichment(db, 'store.com', 'newhandle');
    expect(result.matched).toBe(true);
  });
});
