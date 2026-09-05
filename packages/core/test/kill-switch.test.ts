import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KillSwitch, KillSwitchActiveError } from '../src/kill-switch/kill-switch.js';
import { SystemConfigService } from '../src/config/system-config.js';
import { createTestDb } from './helpers/test-db.js';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '../src/db/client.js';

describe('KillSwitch', () => {
  let db: MetrivioDb;
  let sqlite: Database.Database;
  let killSwitch: KillSwitch;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    killSwitch = new KillSwitch(new SystemConfigService(db));
  });

  afterEach(() => sqlite.close());

  it('is inactive by default', async () => {
    expect(await killSwitch.isActive()).toBe(false);
  });

  it('assertNotActive resolves silently when inactive', async () => {
    await expect(killSwitch.assertNotActive('outreach.dm.send')).resolves.toBeUndefined();
  });

  it('assertNotActive throws KillSwitchActiveError once activated', async () => {
    await killSwitch.activate('test-operator');
    await expect(killSwitch.assertNotActive('outreach.dm.send')).rejects.toBeInstanceOf(KillSwitchActiveError);
  });

  it('the thrown error names the action type that was refused', async () => {
    await killSwitch.activate('test-operator');
    await expect(killSwitch.assertNotActive('content.post.publish')).rejects.toThrow(/content\.post\.publish/);
  });

  it('can be deactivated again', async () => {
    await killSwitch.activate('test-operator');
    expect(await killSwitch.isActive()).toBe(true);
    await killSwitch.deactivate('test-operator');
    expect(await killSwitch.isActive()).toBe(false);
    await expect(killSwitch.assertNotActive('outreach.dm.send')).resolves.toBeUndefined();
  });
});
