import type {
  XReadAdapter,
  XReadOptions,
  ProfileResult,
  TweetResult,
  AccountResult,
} from '@metrivio/core';
import {
  KillSwitch,
  XReadRateLimitedError,
  XReadAuthenticationRequiredError,
  XReadNotFoundError,
  XReadNetworkError,
  XReadUnexpectedError,
} from '@metrivio/core';
import { NotImplementedInStage4AError } from './not-implemented.js';

import { TwitterHttpClient } from '../vendor/xactions-http/src/scrapers/twitter/http/client.js';
import { scrapeProfile } from '../vendor/xactions-http/src/scrapers/twitter/http/profile.js';
import type { RawXProfile } from '../vendor/xactions-http/src/scrapers/twitter/http/profile.js';
import { searchTweets as xaSearchTweets } from '../vendor/xactions-http/src/scrapers/twitter/http/search.js';
import type { RawXTweet } from '../vendor/xactions-http/src/scrapers/twitter/http/search.js';
import {
  TwitterApiError,
  RateLimitError,
  AuthError,
  NotFoundError,
  NetworkError,
} from '../vendor/xactions-http/src/scrapers/twitter/http/errors.js';

/**
 * XActions-backed implementation of XReadAdapter — Stage 4A: the read-only
 * foundation only (`getProfile`, `searchTweets`). Discovery orchestration
 * (keyword/founder/pain-intent/account-graph strategies, candidate ranking,
 * automatic prospect creation) is explicitly out of scope for this stage —
 * see `NotImplementedInStage4AError` on the remaining five methods.
 *
 * Architectural rule (unchanged from OpenTechAnalyzer's Stage 2 pattern):
 * this is the ONLY production file outside `vendor/xactions-http/` that
 * imports vendored XActions code. Nothing in `packages/core` or
 * `packages/prospecting` ever sees an XActions type or error directly —
 * every failure is re-thrown as one of the generic `XRead*Error` classes
 * from `@metrivio/core`.
 */

export interface XActionsReadAdapterOptions {
  /**
   * Required. Every read call checks this before hitting the network — per
   * this stage's approved policy decision, the kill switch protects X read
   * activity too, not only writes (ARCHITECTURE.md §7 currently documents it
   * as write-scoped; this is the smallest safe call-site change needed to
   * extend that coverage to reads, not a redesign of `KillSwitch` itself).
   */
  killSwitch: KillSwitch;
  /**
   * Cookie string (`auth_token=...; ct0=...`). Omit for guest-token mode
   * (the default) — no X login is required for public profile/search reads.
   * If provided, must come from the existing credential/encryption storage
   * (DATABASE.md `credentials` table, `adapter: 'xactions'`), never a plain
   * environment variable read inline at call time.
   */
  sessionCookie?: string;
  /** Test-only escape hatch to inject a pre-built client instead of constructing one. Never used in production wiring. */
  client?: TwitterHttpClient;
}

function mapProfile(raw: RawXProfile): ProfileResult {
  const result: ProfileResult = {
    username: raw.username,
  };
  if (raw.id) result.userId = raw.id;
  if (raw.name) result.displayName = raw.name;
  if (raw.bio) result.bio = raw.bio;
  if (raw.website) result.website = raw.website;
  if (typeof raw.followers === 'number') result.followerCount = raw.followers;
  if (typeof raw.following === 'number') result.followingCount = raw.following;
  if (typeof raw.tweets === 'number') result.postCount = raw.tweets;
  if (raw.location) result.location = raw.location;
  // No last-activity-date field exists on a profile response (verified —
  // parseUserData carries no "last tweet at" timestamp); left unset rather
  // than invented from `joined` or anything else.
  return result;
}

function mapTweet(raw: RawXTweet): TweetResult {
  // XActions' parsed tweet object carries no permalink field directly
  // (verified by source inspection) — X's URL structure is well-known and
  // stable, so it is constructed here rather than left absent, using only
  // fields already present on the object (id, author.username).
  const username = raw.author?.username || '';
  const id = raw.id || '';
  return {
    id,
    authorUsername: username,
    text: raw.text,
    createdAt: raw.createdAt || '',
    url: username && id ? `https://x.com/${username}/status/${id}` : '',
  };
}

/**
 * Maps XActions' own error hierarchy (never exposed outside this file) to
 * the generic `XRead*Error` classes every `XReadAdapter` implementation must
 * throw instead. Order matters: check the more specific subclasses first
 * (`RateLimitError`/`AuthError`/`NotFoundError`/`NetworkError` all extend
 * `TwitterApiError`).
 */
function mapError(adapterName: string, method: string, err: unknown): Error {
  if (err instanceof RateLimitError) {
    return new XReadRateLimitedError(adapterName, method, err.message);
  }
  if (err instanceof AuthError) {
    return new XReadAuthenticationRequiredError(adapterName, method, err.message);
  }
  if (err instanceof NotFoundError) {
    return new XReadNotFoundError(adapterName, method, err.message);
  }
  if (err instanceof NetworkError) {
    return new XReadNetworkError(adapterName, method, err.message);
  }
  if (err instanceof TwitterApiError) {
    // A generic/unclassified API error (e.g. a suspended-account message
    // that didn't match one of the specific subclasses above, or a
    // malformed/unrecognized GraphQL error payload) — never silently
    // treated as "nothing found."
    return new XReadUnexpectedError(adapterName, method, err.message);
  }
  return new XReadUnexpectedError(
    adapterName,
    method,
    err instanceof Error ? err.message : String(err)
  );
}

export class XActionsReadAdapter implements XReadAdapter {
  private static readonly NAME = 'XActionsReadAdapter';
  private readonly killSwitch: KillSwitch;
  private readonly client: TwitterHttpClient;

  constructor(options: XActionsReadAdapterOptions) {
    this.killSwitch = options.killSwitch;
    this.client =
      options.client ??
      new TwitterHttpClient({
        cookies: options.sessionCookie || undefined,
        rateLimitStrategy: 'error',
      });
  }

  async getProfile(handle: string): Promise<ProfileResult> {
    await this.killSwitch.assertNotActive('x.read.getProfile');
    try {
      const raw = await scrapeProfile(this.client, handle);
      return mapProfile(raw);
    } catch (err) {
      throw mapError(XActionsReadAdapter.NAME, 'getProfile', err);
    }
  }

  async searchTweets(query: string, opts?: XReadOptions): Promise<TweetResult[]> {
    await this.killSwitch.assertNotActive('x.read.searchTweets');
    try {
      const raw = await xaSearchTweets(this.client, query, {
        limit: opts?.limit,
        cursor: opts?.cursor ?? null,
      });
      return raw.map(mapTweet);
    } catch (err) {
      throw mapError(XActionsReadAdapter.NAME, 'searchTweets', err);
    }
  }

  async getFollowers(_handle: string, _opts?: XReadOptions): Promise<AccountResult[]> {
    throw new NotImplementedInStage4AError(XActionsReadAdapter.NAME, 'getFollowers');
  }

  async getFollowing(_handle: string, _opts?: XReadOptions): Promise<AccountResult[]> {
    throw new NotImplementedInStage4AError(XActionsReadAdapter.NAME, 'getFollowing');
  }

  async getTweets(_handle: string, _opts?: XReadOptions): Promise<TweetResult[]> {
    throw new NotImplementedInStage4AError(XActionsReadAdapter.NAME, 'getTweets');
  }

  async getListMembers(_listUrl: string): Promise<AccountResult[]> {
    throw new NotImplementedInStage4AError(XActionsReadAdapter.NAME, 'getListMembers');
  }

  async getEngagers(_tweetUrl: string): Promise<AccountResult[]> {
    throw new NotImplementedInStage4AError(XActionsReadAdapter.NAME, 'getEngagers');
  }
}
