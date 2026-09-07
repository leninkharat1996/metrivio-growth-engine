import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { KillSwitch, SystemConfigService, type MetrivioDb } from '@metrivio/core';
import {
  XPublishAuthenticationRequiredError,
  XPublishRateLimitedError,
  XPublishInvalidContentError,
  XPublishNetworkError,
  XPublishUnexpectedError,
} from '@metrivio/core';
import { createTestDb } from './helpers/test-db.js';
import type { PostTweetApiResponse } from '../vendor/x-manager-http/post-tweet.js';

/**
 * All tests here inject a fake `postTweetHttpImpl` — never a real `fetch`
 * call. No live X request is made or claimed anywhere in this file
 * (LIVE X TESTING: NOT PERFORMED — see RISK_REGISTER.md §2L).
 */
const { XManagerPublishAdapter } = await import('../src/xmanager-publish.adapter.js');

const credentials = { consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats' };

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

function fakePostTweetHttp(response: PostTweetApiResponse) {
  return vi.fn().mockResolvedValue(response);
}

describe('XManagerPublishAdapter.publishPost — kill switch / credential preconditions', () => {
  it('refuses when the kill switch is active, before ever building an auth header or calling the transport', async () => {
    const config = new SystemConfigService(db);
    await config.setKillSwitch(true, 'test');
    const activeKillSwitch = new KillSwitch(config);
    const postTweetHttpImpl = fakePostTweetHttp({ data: { id: '1', text: 'hi' } });
    const adapter = new XManagerPublishAdapter({ killSwitch: activeKillSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toThrow(/Kill switch is active/);
    expect(postTweetHttpImpl).not.toHaveBeenCalled();
  });

  it('throws XPublishAuthenticationRequiredError when no credentials are configured, before calling the transport', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ data: { id: '1', text: 'hi' } });
    const adapter = new XManagerPublishAdapter({ killSwitch, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishAuthenticationRequiredError);
    expect(postTweetHttpImpl).not.toHaveBeenCalled();
  });

  it('checks the kill switch before the credentials precondition', async () => {
    const config = new SystemConfigService(db);
    await config.setKillSwitch(true, 'test');
    const activeKillSwitch = new KillSwitch(config);
    const adapter = new XManagerPublishAdapter({ killSwitch: activeKillSwitch });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toThrow(/Kill switch is active/);
  });
});

describe('XManagerPublishAdapter.publishPost — request construction (verified transport)', () => {
  it('calls the transport with the verified base URL, a built OAuth1 Authorization header, and the exact text', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ data: { id: '1', text: 'hello world' } });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await adapter.publishPost({ text: 'hello world' });
    expect(postTweetHttpImpl).toHaveBeenCalledTimes(1);
    const [baseUrl, authorizationHeader, text] = postTweetHttpImpl.mock.calls[0] as [string, string, string];
    expect(baseUrl).toBe('https://api.x.com');
    expect(authorizationHeader.startsWith('OAuth ')).toBe(true);
    expect(text).toBe('hello world');
  });

  it('honors an injected base URL override', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ data: { id: '1', text: 'hi' } });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, baseUrl: 'https://custom.example', postTweetHttpImpl });
    await adapter.publishPost({ text: 'hi' });
    expect(postTweetHttpImpl.mock.calls[0]?.[0]).toBe('https://custom.example');
  });
});

describe('XManagerPublishAdapter.publishPost — success path', () => {
  it('returns the canonical X post ID and published text exactly as returned by the transport, never fabricated', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ data: { id: '1987654321', text: 'the actual returned text' } });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    const result = await adapter.publishPost({ text: 'the original text' });
    expect(result.xPostId).toBe('1987654321');
    expect(result.publishedText).toBe('the actual returned text');
    expect(typeof result.publishedAt).toBe('string');
  });

  it('falls back to the request text if X does not echo one back', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ data: { id: '1', text: '' } });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    const result = await adapter.publishPost({ text: 'fallback text' });
    expect(result.publishedText).toBe('fallback text');
  });
});

describe('XManagerPublishAdapter.publishPost — error mapping', () => {
  it('maps HTTP 401 to XPublishAuthenticationRequiredError', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ httpStatus: 401, errors: [{ message: 'Unauthorized' }] });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishAuthenticationRequiredError);
  });

  it('maps HTTP 403 (e.g. read-only app permissions) to XPublishAuthenticationRequiredError', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ httpStatus: 403, errors: [{ message: 'read-only permissions', type: 'oauth1-permissions' }] });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishAuthenticationRequiredError);
  });

  it('maps HTTP 429 to XPublishRateLimitedError', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ httpStatus: 429, errors: [{ message: 'Too Many Requests' }] });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishRateLimitedError);
  });

  it('maps HTTP 400 to XPublishInvalidContentError', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ httpStatus: 400, errors: [{ message: 'text too long' }] });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishInvalidContentError);
  });

  it('maps HTTP 422 to XPublishInvalidContentError', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ httpStatus: 422, errors: [{ message: 'duplicate content' }] });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishInvalidContentError);
  });

  it('maps a network_error-typed response (no httpStatus) to XPublishNetworkError, never FAILED-equivalent', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ errors: [{ message: 'fetch failed', type: 'network_error' }] });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishNetworkError);
  });

  it('maps an unrecognized 5xx status to XPublishUnexpectedError', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ httpStatus: 503, errors: [{ message: 'Service Unavailable' }] });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishUnexpectedError);
  });

  it('maps a response with neither data nor errors to XPublishUnexpectedError, never claims success', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ httpStatus: 200 });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    await expect(adapter.publishPost({ text: 'hi' })).rejects.toBeInstanceOf(XPublishUnexpectedError);
  });

  it('never lets a vendor-internal error type escape — every thrown error is one of the XPublish* classes', async () => {
    const postTweetHttpImpl = fakePostTweetHttp({ httpStatus: 418, errors: [{ message: "I'm a teapot" }] });
    const adapter = new XManagerPublishAdapter({ killSwitch, credentials, postTweetHttpImpl });
    try {
      await adapter.publishPost({ text: 'hi' });
      expect.fail('expected publishPost to throw');
    } catch (err) {
      expect((err as Error).name.startsWith('XPublish')).toBe(true);
    }
  });
});
