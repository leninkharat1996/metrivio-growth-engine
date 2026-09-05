import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WriteGuard } from '../src/automation/guard.js';
import { KillSwitch, KillSwitchActiveError } from '../src/kill-switch/kill-switch.js';
import { SystemConfigService } from '../src/config/system-config.js';
import { createTestDb } from './helpers/test-db.js';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '../src/db/client.js';

describe('WriteGuard', () => {
  let db: MetrivioDb;
  let sqlite: Database.Database;
  let guard: WriteGuard;
  let config: SystemConfigService;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    config = new SystemConfigService(db);
    guard = new WriteGuard(new KillSwitch(config), config);
  });

  afterEach(() => sqlite.close());

  it('returns the current automation mode when the kill switch is off', async () => {
    await config.setAutomationMode('prospecting.outreach', 'approval_required', 'test');
    const result = await guard.checkBeforeWrite('prospecting.outreach', 'outreach.dm.send');
    expect(result.mode).toBe('approval_required');
  });

  it('the kill switch always wins, regardless of automation mode', async () => {
    await config.setAutomationMode('prospecting.outreach', 'autonomous', 'test');
    await config.setKillSwitch(true, 'test');
    await expect(guard.checkBeforeWrite('prospecting.outreach', 'outreach.dm.send')).rejects.toBeInstanceOf(
      KillSwitchActiveError
    );
  });

  it('subsystems are checked independently', async () => {
    await config.setAutomationMode('prospecting.outreach', 'autonomous', 'test');
    await config.setAutomationMode('content.publishing', 'dry_run', 'test');
    const outreach = await guard.checkBeforeWrite('prospecting.outreach', 'outreach.dm.send');
    const content = await guard.checkBeforeWrite('content.publishing', 'content.post.publish');
    expect(outreach.mode).toBe('autonomous');
    expect(content.mode).toBe('dry_run');
  });
});
