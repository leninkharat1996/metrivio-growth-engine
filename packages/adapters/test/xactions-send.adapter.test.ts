import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { KillSwitch, SystemConfigService, type MetrivioDb } from '@metrivio/core';
import {
  XSendAuthenticationRequiredError,
  XSendRateLimitedError,
  XSendNotFoundError,
  XSendNetworkError,
  XSendUnexpectedError,
} from '@metrivio/core';
import { createTestDb } from './helpers/test-db.js';

/**
 * All tests here are against a mocked `TwitterHttpClient`-shaped object
 * injected via `XActionsSendAdapterOptions.client` — never a real
 * `fetch`/network call. This is important specifically for this file:
 * `sendDirectMessage()` now calls through to the vendored `sendDM()`,
 * which performs a real `client.request()` HTTP call when given a real
 * `TwitterHttpClient` — every test must inject a fake client instead of
 * relying on the default constructor, or it would attempt (and, depending
 * on this environment's egress policy at any given time, could partially
 * complete) a live request to x.com. No live X request is made or claimed
 * anywhere in this file.
 */
const { XActionsSendAdapter } = await import('../src/xactions-send.adapter.js');

function fakeClient(overrides: Partial<{ isAuthenticated: () => boolean; request: (url: string, opts: unknown) => Promise<unknown> }> = {}) {
  return {
    isAuthenticated: overrides.isAuthenticated ?? (() => true),
    request: overrides.request ?? vi.fn().mockResolvedValue({ event: { id: 'm1', created_timestamp: '1700000000000' } }),
  };
}

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

describe('XActionsSendAdapter.sendDirectMessage — kill switch / auth preconditions', () => {
  it('refuses when the kill switch is active, before ever touching the client', async () => {
    const config = new SystemConfigService(db);
    await config.setKillSwitch(true, 'test');
    const activeKillSwitch = new KillSwitch(config);
    const request = vi.fn();
    const adapter = new XActionsSendAdapter({ killSwitch: activeKillSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '123', messageText: 'hi' })).rejects.toThrow(/Kill switch is active/);
    expect(request).not.toHaveBeenCalled();
  });

  it('throws XSendAuthenticationRequiredError when the client reports unauthenticated, before calling request()', async () => {
    const request = vi.fn();
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ isAuthenticated: () => false, request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '123', messageText: 'hi' })).rejects.toBeInstanceOf(XSendAuthenticationRequiredError);
    expect(request).not.toHaveBeenCalled();
  });

  it('checks the kill switch before the authentication precondition', async () => {
    const config = new SystemConfigService(db);
    await config.setKillSwitch(true, 'test');
    const activeKillSwitch = new KillSwitch(config);
    const adapter = new XActionsSendAdapter({ killSwitch: activeKillSwitch, client: fakeClient({ isAuthenticated: () => false }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '123', messageText: 'hi' })).rejects.toThrow(/Kill switch is active/);
  });
});

describe('XActionsSendAdapter.sendDirectMessage — request construction', () => {
  it('sends the verified request shape: POST /1.1/dm/new2.json with the message_create body', async () => {
    const request = vi.fn().mockResolvedValue({ event: { id: 'm1', created_timestamp: '1700000000000' } });
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });

    await adapter.sendDirectMessage({ targetUserId: '999888777', messageText: 'Hello there' });

    expect(request).toHaveBeenCalledOnce();
    const [url, opts] = request.mock.calls[0] as [string, { method: string; body: unknown }];
    expect(url).toContain('/1.1/dm/new2.json');
    expect(opts.method).toBe('POST');
    expect(opts.body).toEqual({
      event: {
        type: 'message_create',
        message_create: {
          target: { recipient_id: '999888777' },
          message_data: { text: 'Hello there' },
        },
      },
    });
  });

  it('uses the canonical numeric user id as-is, never a username', async () => {
    const request = vi.fn().mockResolvedValue({ event: { id: 'm1', created_timestamp: '1700000000000' } });
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });

    await adapter.sendDirectMessage({ targetUserId: '42', messageText: 'hi' });
    const [, opts] = request.mock.calls[0] as [string, { body: { event: { message_create: { target: { recipient_id: string } } } } }];
    expect(opts.body.event.message_create.target.recipient_id).toBe('42');
  });
});

describe('XActionsSendAdapter.sendDirectMessage — successful response', () => {
  it('returns the messageId/sentAt mapped from the verified response shape', async () => {
    const request = vi.fn().mockResolvedValue({ event: { id: 'abc123', created_timestamp: '1700000000000' } });
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });

    const result = await adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' });
    expect(result.xMessageId).toBe('abc123');
    expect(result.sentAt).toBe(new Date(1700000000000).toISOString());
  });

  it('falls back to the current time when the response carries no created_timestamp', async () => {
    const request = vi.fn().mockResolvedValue({ event: { id: 'abc123' } });
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });

    const result = await adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' });
    expect(result.sentAt).toBeTruthy();
  });
});

describe('XActionsSendAdapter.sendDirectMessage — known error mapping', () => {
  it('maps an AuthError response to XSendAuthenticationRequiredError', async () => {
    const { AuthError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new AuthError('Authentication failed (403)'));
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' })).rejects.toBeInstanceOf(XSendAuthenticationRequiredError);
  });

  it('maps a RateLimitError to XSendRateLimitedError', async () => {
    const { RateLimitError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new RateLimitError('Rate limited'));
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' })).rejects.toBeInstanceOf(XSendRateLimitedError);
  });

  it('maps a NotFoundError to XSendNotFoundError', async () => {
    const { NotFoundError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new NotFoundError('Resource not found'));
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' })).rejects.toBeInstanceOf(XSendNotFoundError);
  });

  it('maps a NetworkError to XSendNetworkError', async () => {
    const { NetworkError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new NetworkError('timeout'));
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' })).rejects.toBeInstanceOf(XSendNetworkError);
  });

  it('maps a malformed/unrecognized TwitterApiError to XSendUnexpectedError', async () => {
    const { TwitterApiError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new TwitterApiError('HTTP 500'));
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' })).rejects.toBeInstanceOf(XSendUnexpectedError);
  });

  it('maps a missing recipientId / empty text precondition error (thrown by the vendored sendDM itself) to XSendUnexpectedError', async () => {
    const request = vi.fn();
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '', messageText: 'hi' })).rejects.toBeInstanceOf(XSendUnexpectedError);
    expect(request).not.toHaveBeenCalled();
  });

  it('maps a completely unrecognized thrown value to XSendUnexpectedError rather than leaking it', async () => {
    const request = vi.fn().mockRejectedValue(new Error('some other internal failure'));
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });
    await expect(adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' })).rejects.toBeInstanceOf(XSendUnexpectedError);
  });
});

describe('XActionsSendAdapter.sendDirectMessage — credential safety', () => {
  it('never includes cookie/credential material in a thrown error message', async () => {
    const { NetworkError } = await import('../vendor/xactions-http/src/scrapers/twitter/http/errors.js');
    const request = vi.fn().mockRejectedValue(new NetworkError('timeout while sending'));
    const adapter = new XActionsSendAdapter({ killSwitch, client: fakeClient({ request }) as never });
    try {
      await adapter.sendDirectMessage({ targetUserId: '1', messageText: 'hi' });
      expect.unreachable();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/auth_token|ct0=|cookie:/i);
    }
  });
});
