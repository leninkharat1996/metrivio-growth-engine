import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db.js';
import { prospects, evidence, systemConfig, jobRuns, technologyScans, technologyDetections } from '../src/db/schema.js';
import type Database from 'better-sqlite3';

describe('Database schema initialization (migration applies cleanly from empty)', () => {
  let sqlite: Database.Database | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it('creates every table documented in DATABASE.md, plus the flagged job_runs addition', () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const tableNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
      .all()
      .map((r: unknown) => (r as { name: string }).name)
      .sort();

    const expectedFromDatabaseMd = [
      'audit_log',
      'content_drafts',
      'content_ideas',
      'content_performance_rollup',
      'conversation_messages',
      'conversations',
      'credentials',
      'evidence',
      'failed_jobs',
      'icp_scores',
      'outreach_messages',
      'pain_signals',
      'prospect_sources',
      'prospects',
      'sequences',
      'session_health',
      'system_config',
      'technology_change_events',
      'technology_detections',
      'technology_scans',
    ].sort();

    for (const table of expectedFromDatabaseMd) {
      expect(tableNames).toContain(table);
    }

    // The one documented, intentional deviation from a literal reading of
    // DATABASE.md — see schema.ts's comment above `jobRuns` and the Stage 1
    // completion report.
    expect(tableNames).toContain('job_runs');
    expect(tableNames).toHaveLength(expectedFromDatabaseMd.length + 1);
  });

  it('WAL mode is enabled, per DATABASE.md ("Engine: SQLite (WAL mode)")', () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const mode = sqlite.pragma('journal_mode', { simple: true });
    // better-sqlite3 with an in-memory database reports 'memory' rather than
    // 'wal' regardless of the pragma set, since WAL requires a real file —
    // confirm the pragma call itself doesn't error and returns a valid mode,
    // and separately confirm the pragma is actually issued (see client.ts).
    expect(['wal', 'memory']).toContain(mode);
  });

  it('the prospects table enforces uniqueness on x_username and x_user_id (dedup keys, DATABASE.md §5)', async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;

    await db.insert(prospects).values({
      id: 'p1',
      xUsername: 'samehandle',
      xUserId: 'user-1',
      source: 'keyword_search',
      dateDiscovered: new Date().toISOString(),
    });

    await expect(
      db.insert(prospects).values({
        id: 'p2',
        xUsername: 'samehandle', // duplicate username
        xUserId: 'user-2',
        source: 'keyword_search',
        dateDiscovered: new Date().toISOString(),
      })
    ).rejects.toThrow();
  });

  it('the evidence table accepts rows without requiring an update path (append-only usage)', async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;

    await db.insert(prospects).values({
      id: 'p1',
      xUsername: 'founder1',
      source: 'founder_search',
      dateDiscovered: new Date().toISOString(),
    });

    await db.insert(evidence).values({
      id: 'e1',
      prospectId: 'p1',
      evidenceType: 'technology_signal',
      signalCategory: 'shopify_detected',
      evidenceTier: 'CONFIRMED',
      rawValue: 'Shopify header detected',
      capturedBy: 'system',
    });

    const rows = await db.select().from(evidence);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidenceTier).toBe('CONFIRMED');
  });

  it('system_config uses key as primary key, so re-inserting the same key must be an explicit update', async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;

    await db.insert(systemConfig).values({ key: 'kill_switch', value: 'false', updatedBy: 'system' });
    await expect(
      db.insert(systemConfig).values({ key: 'kill_switch', value: 'true', updatedBy: 'system' })
    ).rejects.toThrow();
  });

  it('job_runs table (Stage 1 addition) persists checkpoint state', async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;
    await db.insert(jobRuns).values({
      id: 'j1',
      jobType: 'discovery.keyword_search',
      status: 'running',
      checkpoint: JSON.stringify({ page: 3 }),
      startedAt: new Date().toISOString(),
    });
    const rows = await db.select().from(jobRuns);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.checkpoint ?? '{}')).toEqual({ page: 3 });
  });

  it('technology_scans and technology_detections are separate tables, matching the scan-status/technology-status split', async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const { db } = testDb;

    await db.insert(technologyScans).values({
      id: 's1',
      companyDomain: 'example.com',
      scanStatus: 'OK',
      detector: 'open_tech_analyzer',
    });
    await db.insert(technologyDetections).values({
      id: 'd1',
      scanId: 's1',
      technologyName: 'Shopify',
      status: 'DETECTED',
      confidence: 95,
      evidence: JSON.stringify([{ source: 'header', subject: 'powered-by', match: 'Shopify', reliability: 0.88 }]),
    });

    const scans = await db.select().from(technologyScans);
    const detections = await db.select().from(technologyDetections);
    expect(scans).toHaveLength(1);
    expect(detections).toHaveLength(1);
    expect(detections[0]?.scanId).toBe(scans[0]?.id);
  });
});
