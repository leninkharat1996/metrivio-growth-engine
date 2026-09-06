import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { KillSwitch, SystemConfigService, XSendAuthenticationRequiredError, XSendUnexpectedError, type MetrivioDb } from '@metrivio/core';
import { createTestDb } from './helpers/test-db.js';
import { XActionsSendAdapter } from '../src/xactions-send.adapter.js';

/**
 * No live network call is made or possible here — this environment's
 * egress policy blocks arbitrary outbound HTTP (confirmed in earlier
 * stages of this session). Every test exercises the adapter's own
 * pre-network-write logic (kill switch, auth precondition, the documented
 * capability gap) without a real `TwitterHttpClient` request ever being
 * attempted, since the adapter itself never reaches that point.
 */

let db: MetrivioDb;
let sqlite: Database.Database;
let killSwitch: KillSwitch;

beforeEach(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  const config = new SystemConfigService(db);
  await config.setKillSwitch(false, 'test');
  killSwitch = new KillSwitch(config);
});

afterEach(() => sqlite.close());

describe('XActionsSendAdapter.sendDirectMessage', () => {
  it('refuses when the kill switch is active', async () => {
    const config = new SystemConfigService(db);
    await config.setKillSwitch(true, 'test');
    const activeKillSwitch = new KillSwitch(config);
    const adapter = new XActionsSendAdapter({ killSwitch: activeKillSwitch, sessionCookie: 'auth_token=abc; ct0=xyz' });
    await expect(adapter.sendDirectMessage({ targetUserId: '123', messageText: 'hi' })).rejects.toThrow(/Kill switch is active/);
  });

  it('throws XSendAuthenticationRequiredError when no session cookie is configured', async () => {
    const adapter = new XActionsSendAdapter({ killSwitch });
    await expect(adapter.sendDirectMessage({ targetUserId: '123', messageText: 'hi' })).rejects.toBeInstanceOf(XSendAuthenticationRequiredError);
  });

  it('throws XSendUnexpectedError (documented capability gap) even with valid-looking credentials', async () => {
    const adapter = new XActionsSendAdapter({ killSwitch, sessionCookie: 'auth_token=abc; ct0=xyz' });
    await expect(adapter.sendDirectMessage({ targetUserId: '123', messageText: 'hi' })).rejects.toBeInstanceOf(XSendUnexpectedError);
  });

  it('the XSendUnexpectedError message explains the gap without leaking any credential material', async () => {
    const adapter = new XActionsSendAdapter({ killSwitch, sessionCookie: 'auth_token=super-secret-token; ct0=another-secret' });
    try {
      await adapter.sendDirectMessage({ targetUserId: '123', messageText: 'hi' });
      expect.unreachable();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/dm\.js/);
      expect(message).not.toContain('super-secret-token');
      expect(message).not.toContain('another-secret');
    }
  });

  it('checks the kill switch before the authentication precondition', async () => {
    const config = new SystemConfigService(db);
    await config.setKillSwitch(true, 'test');
    const activeKillSwitch = new KillSwitch(config);
    // No session cookie either — if auth were checked first we'd see XSendAuthenticationRequiredError instead.
    const adapter = new XActionsSendAdapter({ killSwitch: activeKillSwitch });
    await expect(adapter.sendDirectMessage({ targetUserId: '123', messageText: 'hi' })).rejects.toThrow(/Kill switch is active/);
  });
});
