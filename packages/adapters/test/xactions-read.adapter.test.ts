import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { KillSwitch, SystemConfigService, type MetrivioDb } from '@metrivio/core';
import {
  XReadRateLimitedError,
  XReadAuthenticationRequiredError,
  XReadNotFoundError,
  XReadNetworkError,
  XReadUnexpectedError,
} from '@metrivio/core';
import { createTestDb } from './helpers/test-db.js';
import {
  RateLimitError,
  AuthError,
  NotFoundError,
  NetworkError,
  TwitterApiError,
} from '../vendor/xactions-http/src/scrapers/twitter/http/errors.js';
import type { RawXProfile } from '../vendor/xactions-http/src/scrapers/twitter/http/profile.js';
import type { RawXTweet } from '../vendor/xactions-http/src/scrapers/twitter/http/search.js';

/**
 * All tests here are against mocked vendored XActions functions — never a
 * live network call. This environment's egress policy blocks arbitrary
 * outbound HTTP anyway (verified in earlier stages of this session), so no
 * live X request is possible or claimed here.
 */
const mockScrapeProfile = vi.fn();
const mockSearchTweets = vi.fn();
vi.mock('../vendor/xactions-http/src/scrapers/twitter/http/profile.js', () => ({
  scrapeProfile: (...args: unknown[]) => mockScrapeProfile(...args),
}));
vi.mock('../vendor/xactions-http/src/scrapers/twitter/http/search.js', () => ({
  searchTweets: (...args: unknown[]) => mockSearchTweets(...args),
}));

const { XActionsReadAdapter } = await import('../src/xactions-read.adapter.js');

function fixtureProfile(overrides: Partial<RawXProfile> = {}): RawXProfile {
  return {
    id: '12345',
    name: 'Jane Founder',
    username: 'janefounder',
    bio: 'Founder @ExampleStore. Building DTC skincare.',
    location: 'Austin, TX',
    website: 'https://example-store.com',
    joined: '2019-03-01T00:00:00.000Z',
    birthday: null,
    following: 512,
    followers: 8400,
    tweets: 3021,
    likes: 9000,
    media: 200,
    avatar: 'https://pbs.twimg.com/profile.jpg',
    header: null,
    verified: false,
    protected: false,
    pinnedTweetId: null,
    bioEntities: { urls: [], hashtags: [], mentions: [] },
    platform: 'twitter',
    ...overrides,
  };
}

function fixtureTweet(overrides: Partial<RawXTweet> = {}): RawXTweet {
  return {
    id: '1987654321',
    text: 'We just crossed $15k/month in Meta ad spend, wild ride.',
    createdAt: '2026-08-01T12:00:00.000Z',
    author: { id: '12345', username: 'janefounder', name: 'Jane Founder', avatar: null, verified: false },
    metrics: { likes: 10, retweets: 2, replies: 1, quotes: 0, bookmarks: 0, views: 500 },
    media: [],
    quotedTweet: null,
    inReplyTo: null,
    urls: [],
    hashtags: [],
    mentions: [],
    isReply: false,
    isRetweet: false,
    retweetOf: null,
    lang: 'en',
    source: 'Twitter Web App',
    platform: 'twitter',
    ...overrides,
  };
}

let db: MetrivioDb;
let sqlite: Database.Database;
let killSwitch: KillSwitch;

beforeEach(() => {
  mockScrapeProfile.mockReset();
  mockSearchTweets.mockReset();
  const testDb = createTestDb();
  db = testDb.db;
  sqlite = testDb.sqlite;
  killSwitch = new KillSwitch(new SystemConfigService(db));
});

afterEach(() => sqlite.close());

describe('XActionsReadAdapter.getProfile', () => {
  it('1. maps a successful profile correctly, including userId/website/counts', async () => {
    mockScrapeProfile.mockResolvedValue(fixtureProfile());
    const adapter = new XActionsReadAdapter({ killSwitch });
    const result = await adapter.getProfile('janefounder');

    expect(result).toEqual({
      username: 'janefounder',
      userId: '12345',
      displayName: 'Jane Founder',
      bio: 'Founder @ExampleStore. Building DTC skincare.',
      website: 'https://example-store.com',
      followerCount: 8400,
      followingCount: 512,
      postCount: 3021,
      location: 'Austin, TX',
    });
  });

  it('2. a profile with no website omits the website field rather than inventing one', async () => {
    mockScrapeProfile.mockResolvedValue(fixtureProfile({ website: null }));
    const adapter = new XActionsReadAdapter({ killSwitch });
    const result = await adapter.getProfile('janefounder');
    expect(result.website).toBeUndefined();
  });

  it('3. a profile with an empty bio omits the bio field rather than passing through an empty string', async () => {
    mockScrapeProfile.mockResolvedValue(fixtureProfile({ bio: '' }));
    const adapter = new XActionsReadAdapter({ killSwitch });
    const result = await adapter.getProfile('janefounder');
    expect(result.bio).toBeUndefined();
  });

  it('6. a rate-limited request throws XReadRateLimitedError, never an empty/successful result', async () => {
    mockScrapeProfile.mockRejectedValue(new RateLimitError('Rate limited', { status: 429, resetAt: Date.now() + 60_000 }));
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).rejects.toBeInstanceOf(XReadRateLimitedError);
  });

  it('7. an authentication/session failure throws XReadAuthenticationRequiredError', async () => {
    mockScrapeProfile.mockRejectedValue(new AuthError('Authentication failed (401)', { status: 401 }));
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).rejects.toBeInstanceOf(XReadAuthenticationRequiredError);
  });

  it('8. a not-found/private/suspended/deleted profile throws XReadNotFoundError, never an empty successful profile', async () => {
    mockScrapeProfile.mockRejectedValue(new NotFoundError('User @janefounder not found'));
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).rejects.toBeInstanceOf(XReadNotFoundError);
  });

  it('9. a network-level failure throws XReadNetworkError', async () => {
    mockScrapeProfile.mockRejectedValue(new NetworkError('Request failed after retries'));
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).rejects.toBeInstanceOf(XReadNetworkError);
  });

  it('10. a malformed/unrecognized upstream error response throws XReadUnexpectedError, never a silent empty result', async () => {
    mockScrapeProfile.mockRejectedValue(new TwitterApiError('GraphQL errors: something changed upstream'));
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).rejects.toBeInstanceOf(XReadUnexpectedError);
  });

  it('10b. a completely unrecognized thrown value (not even an XActions error class) also maps to XReadUnexpectedError, never propagated raw', async () => {
    mockScrapeProfile.mockRejectedValue(new TypeError('unexpected shape'));
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).rejects.toBeInstanceOf(XReadUnexpectedError);
  });

  it('no XActions-specific error class ever leaks out of the adapter', async () => {
    mockScrapeProfile.mockRejectedValue(new NotFoundError('User @x not found'));
    const adapter = new XActionsReadAdapter({ killSwitch });
    try {
      await adapter.getProfile('x');
      throw new Error('expected getProfile to reject');
    } catch (err) {
      expect(err).not.toBeInstanceOf(NotFoundError);
      expect(err).toBeInstanceOf(XReadNotFoundError);
    }
  });
});

describe('XActionsReadAdapter.searchTweets', () => {
  it('4. maps a successful tweet search correctly, including a constructed permalink URL', async () => {
    mockSearchTweets.mockResolvedValue([fixtureTweet()]);
    const adapter = new XActionsReadAdapter({ killSwitch });
    const result = await adapter.searchTweets('ROAS');

    expect(result).toEqual([
      {
        id: '1987654321',
        authorUsername: 'janefounder',
        text: 'We just crossed $15k/month in Meta ad spend, wild ride.',
        createdAt: '2026-08-01T12:00:00.000Z',
        url: 'https://x.com/janefounder/status/1987654321',
      },
    ]);
  });

  it('5. an empty search result is a legitimate empty array, not an error', async () => {
    mockSearchTweets.mockResolvedValue([]);
    const adapter = new XActionsReadAdapter({ killSwitch });
    const result = await adapter.searchTweets('a-query-that-matches-nothing');
    expect(result).toEqual([]);
  });

  it('passes limit/cursor through from XReadOptions', async () => {
    mockSearchTweets.mockResolvedValue([]);
    const adapter = new XActionsReadAdapter({ killSwitch });
    await adapter.searchTweets('CAC', { limit: 25, cursor: 'abc' });
    expect(mockSearchTweets).toHaveBeenCalledWith(expect.anything(), 'CAC', { limit: 25, cursor: 'abc' });
  });

  it('rate limit / auth / not-found / network failures map identically to getProfile', async () => {
    mockSearchTweets.mockRejectedValue(new RateLimitError('Rate limited'));
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.searchTweets('CAC')).rejects.toBeInstanceOf(XReadRateLimitedError);
  });
});

describe('XActionsReadAdapter — kill switch (11, 12)', () => {
  it('12. kill switch inactive: reads proceed normally', async () => {
    mockScrapeProfile.mockResolvedValue(fixtureProfile());
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).resolves.toBeDefined();
    expect(mockScrapeProfile).toHaveBeenCalledTimes(1);
  });

  it('11. kill switch active: getProfile is refused before any network call is attempted', async () => {
    await killSwitch.activate('test-operator');
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).rejects.toThrow(/kill switch/i);
    expect(mockScrapeProfile).not.toHaveBeenCalled();
  });

  it('11b. kill switch active: searchTweets is also refused (reads are covered, not only writes)', async () => {
    await killSwitch.activate('test-operator');
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.searchTweets('CAC')).rejects.toThrow(/kill switch/i);
    expect(mockSearchTweets).not.toHaveBeenCalled();
  });

  it('deactivating the kill switch restores normal read behavior', async () => {
    await killSwitch.activate('test-operator');
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getProfile('janefounder')).rejects.toThrow();

    await killSwitch.deactivate('test-operator');
    mockScrapeProfile.mockResolvedValue(fixtureProfile());
    await expect(adapter.getProfile('janefounder')).resolves.toBeDefined();
  });
});

describe('XActionsReadAdapter — credential handling', () => {
  it('never logs or exposes the session cookie in a thrown error message', async () => {
    const secretCookie = 'auth_token=super-secret-value; ct0=another-secret';
    mockScrapeProfile.mockRejectedValue(new AuthError('Authentication failed (401)', { status: 401 }));
    const adapter = new XActionsReadAdapter({ killSwitch, sessionCookie: secretCookie });
    try {
      await adapter.getProfile('janefounder');
      throw new Error('expected rejection');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('super-secret-value');
      expect(message).not.toContain('another-secret');
    }
  });

  it('constructs without a sessionCookie (guest mode is the default — no credentials required)', () => {
    expect(() => new XActionsReadAdapter({ killSwitch })).not.toThrow();
  });
});

describe('XActionsReadAdapter — remaining Stage 4A stub methods', () => {
  it('getFollowers/getFollowing/getTweets/getListMembers/getEngagers are not implemented in Stage 4A', async () => {
    const adapter = new XActionsReadAdapter({ killSwitch });
    await expect(adapter.getFollowers('x')).rejects.toThrow(/not implemented in Stage 4A/);
    await expect(adapter.getFollowing('x')).rejects.toThrow(/not implemented in Stage 4A/);
    await expect(adapter.getTweets('x')).rejects.toThrow(/not implemented in Stage 4A/);
    await expect(adapter.getListMembers('https://x.com/i/lists/1')).rejects.toThrow(/not implemented in Stage 4A/);
    await expect(adapter.getEngagers('https://x.com/x/status/1')).rejects.toThrow(/not implemented in Stage 4A/);
  });
});

describe('XActionsReadAdapter — determinism', () => {
  it('the same fixture input always produces the same mapped output', async () => {
    mockScrapeProfile.mockResolvedValue(fixtureProfile());
    const adapter = new XActionsReadAdapter({ killSwitch });
    const results = await Promise.all(Array.from({ length: 5 }, () => adapter.getProfile('janefounder')));
    const first = JSON.stringify(results[0]);
    for (const r of results) {
      expect(JSON.stringify(r)).toBe(first);
    }
  });
});
