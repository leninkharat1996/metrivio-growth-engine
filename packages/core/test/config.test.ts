import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnv, resetEnvCache } from '../src/config/env.js';
import { SystemConfigService } from '../src/config/system-config.js';
import { createTestDb } from './helpers/test-db.js';
import type Database from 'better-sqlite3';
import type { MetrivioDb } from '../src/db/client.js';

describe('config: environment validation and defaults', () => {
  beforeEach(() => resetEnvCache());
  afterEach(() => resetEnvCache());

  it('applies safe defaults when no env vars are set', () => {
    const env = loadEnv({}, true);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DATABASE_PATH).toBe('./var/metrivio.sqlite');
    // Safe-by-default: automation defaults to dry_run, not autonomous.
    expect(env.PROSPECTING_OUTREACH_AUTOMATION_MODE).toBe('dry_run');
    expect(env.CONTENT_PUBLISHING_AUTOMATION_MODE).toBe('dry_run');
    expect(env.KILL_SWITCH).toBe(false);
    expect(env.ENCRYPTION_KEY).toBe('');
    expect(env.XACTIONS_SESSION_COOKIE).toBe('');
  });

  it('throws rather than silently guessing on an invalid automation mode string', () => {
    resetEnvCache();
    expect(() =>
      loadEnv({ PROSPECTING_OUTREACH_AUTOMATION_MODE: 'not-a-real-mode' } as unknown as NodeJS.ProcessEnv, true)
    ).toThrow(/Invalid environment configuration/);
  });

  it('throws on a genuinely invalid numeric env var', () => {
    resetEnvCache();
    expect(() =>
      loadEnv({ DAILY_LIMIT_DMS: 'abc' } as unknown as NodeJS.ProcessEnv, true)
    ).toThrow(/Invalid environment configuration/);
  });

  it('coerces valid numeric strings correctly', () => {
    const env = loadEnv({ DAILY_LIMIT_DMS: '25' }, true);
    expect(env.DAILY_LIMIT_DMS).toBe(25);
  });

  it('parses boolean-shaped strings for KILL_SWITCH', () => {
    expect(loadEnv({ KILL_SWITCH: 'true' }, true).KILL_SWITCH).toBe(true);
    expect(loadEnv({ KILL_SWITCH: 'false' }, true).KILL_SWITCH).toBe(false);
  });
});

describe('config: SystemConfigService (DB-backed runtime settings)', () => {
  let db: MetrivioDb;
  let sqlite: Database.Database;
  let config: SystemConfigService;

  beforeEach(() => {
    resetEnvCache();
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    config = new SystemConfigService(db);
  });

  afterEach(() => sqlite.close());

  it('returns dry_run as a fail-safe default when nothing has been seeded', async () => {
    const mode = await config.getAutomationMode('prospecting.outreach');
    expect(mode).toBe('dry_run');
  });

  it('seeds defaults from env only for keys with no stored value', async () => {
    const env = loadEnv({ PROSPECTING_OUTREACH_AUTOMATION_MODE: 'autonomous' }, true);
    await config.seedDefaultsFromEnv(env);
    expect(await config.getAutomationMode('prospecting.outreach')).toBe('autonomous');

    // A later Settings change must survive a reseed attempt with different
    // env vars — a restart with a different .env must never silently revert
    // an operator's explicit Settings choice.
    await config.setAutomationMode('prospecting.outreach', 'approval_required', 'test-operator');
    const differentEnv = loadEnv({ PROSPECTING_OUTREACH_AUTOMATION_MODE: 'dry_run' }, true);
    await config.seedDefaultsFromEnv(differentEnv);
    expect(await config.getAutomationMode('prospecting.outreach')).toBe('approval_required');
  });

  it('supports all three automation modes independently per subsystem', async () => {
    await config.setAutomationMode('prospecting.outreach', 'autonomous', 'test');
    await config.setAutomationMode('content.publishing', 'approval_required', 'test');
    expect(await config.getAutomationMode('prospecting.outreach')).toBe('autonomous');
    expect(await config.getAutomationMode('content.publishing')).toBe('approval_required');
  });

  it('defaults daily limits to 0 (nothing allowed) rather than unlimited when unset', async () => {
    expect(await config.getDailyLimit('dms')).toBe(0);
  });

  it('stores and retrieves daily limits as plain configurable numbers', async () => {
    await config.setDailyLimit('dms', 12, 'test-operator');
    expect(await config.getDailyLimit('dms')).toBe(12);
  });

  it('never stores a negative daily limit', async () => {
    await config.setDailyLimit('dms', -5, 'test-operator');
    expect(await config.getDailyLimit('dms')).toBe(0);
  });

  it('defaults session_health_auto_downgrade to true (safety net on) when unset', async () => {
    expect(await config.isSessionHealthAutoDowngradeEnabled()).toBe(true);
  });

  it('returns empty geography/vertical filters by default (no restriction)', async () => {
    expect(await config.getGeographyFilter()).toEqual([]);
    const rules = await config.getVerticalRules();
    expect(rules.inclusion).toEqual([]);
    expect(rules.exclusion).toEqual([]);
  });

  it('kill switch defaults to inactive and can be toggled', async () => {
    expect(await config.isKillSwitchActive()).toBe(false);
    await config.setKillSwitch(true, 'test-operator');
    expect(await config.isKillSwitchActive()).toBe(true);
    await config.setKillSwitch(false, 'test-operator');
    expect(await config.isKillSwitchActive()).toBe(false);
  });
});
