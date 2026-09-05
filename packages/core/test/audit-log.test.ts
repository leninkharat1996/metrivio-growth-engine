import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { writeAuditLog } from '../src/db/audit-log.js';
import { auditLog } from '../src/db/schema.js';
import { createTestDb } from './helpers/test-db.js';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '../src/db/client.js';

describe('audit log', () => {
  let db: MetrivioDb;
  let sqlite: Database.Database;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
  });

  afterEach(() => sqlite.close());

  it('writes a row with the expected shape', async () => {
    await writeAuditLog(db, {
      actor: 'system',
      actionType: 'outreach.dm.sent',
      entityType: 'prospect',
      entityId: 'prospect-123',
      detail: { sequenceStep: 1 },
      dryRun: true,
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.actionType, 'outreach.dm.sent'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe('system');
    expect(rows[0]?.entityId).toBe('prospect-123');
    expect(rows[0]?.dryRun).toBe(true);
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ sequenceStep: 1 });
  });

  it('refuses to write a detail payload containing a credential-shaped key', async () => {
    await expect(
      writeAuditLog(db, {
        actor: 'system',
        actionType: 'outreach.dm.sent',
        detail: { apiKey: 'sk-should-never-be-here' },
      })
    ).rejects.toThrow(/credential-shaped/);

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(0);
  });

  it('defaults dryRun to false when not specified', async () => {
    await writeAuditLog(db, { actor: 'human', actionType: 'config.kill_switch.toggled' });
    const rows = await db.select().from(auditLog);
    expect(rows[0]?.dryRun).toBe(false);
  });
});
