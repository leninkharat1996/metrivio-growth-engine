/**
 * XReadAdapter — ARCHITECTURE.md §6.
 *
 * Covers everything that reads public X data: discovery, enrichment,
 * engagement signals. Implementations sit behind this interface so the
 * primary (XActions) and fallback (twscrape) tools can be swapped without
 * touching pipeline code — see RESEARCH.md §5 point 1.
 *
 * This file defines the contract only. Stage 1 does not implement production
 * network calls against it (see packages/adapters for the Stage 1 stub).
 */

export interface ProfileResult {
  username: string;
  userId?: string;
  displayName?: string;
  bio?: string;
  website?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  location?: string;
  lastActivityAt?: string;
}

export interface TweetResult {
  id: string;
  authorUsername: string;
  text: string;
  createdAt: string;
  url: string;
}

export interface AccountResult {
  username: string;
  userId?: string;
  displayName?: string;
}

export interface XReadOptions {
  limit?: number;
  cursor?: string;
}

export interface XReadAdapter {
  searchTweets(query: string, opts?: XReadOptions): Promise<TweetResult[]>;
  getProfile(handle: string): Promise<ProfileResult>;
  getFollowers(handle: string, opts?: XReadOptions): Promise<AccountResult[]>;
  getFollowing(handle: string, opts?: XReadOptions): Promise<AccountResult[]>;
  getTweets(handle: string, opts?: XReadOptions): Promise<TweetResult[]>;
  getListMembers(listUrl: string): Promise<AccountResult[]>;
  /** Likers/repliers/quoters — used by the content-to-prospecting loop (ARCHITECTURE.md §5). */
  getEngagers(tweetUrl: string): Promise<AccountResult[]>;
}

// ---------------------------------------------------------------------------
// Read-status error classes (Stage 4A additive design)
// ---------------------------------------------------------------------------
//
// The methods above return bare `ProfileResult` / `TweetResult[]` / etc. —
// there is no status wrapper analogous to Stage 2's `TechAnalyzerResult.
// scanStatus` to distinguish a genuine "nothing found" from a blocked,
// rate-limited, or failed request. Widening every method's return type to
// add one would be a real interface change; instead, the same discipline
// already used elsewhere in this codebase for exactly this situation
// (`KillSwitchActiveError`, `NotImplementedInStage1Error` — thrown, not
// embedded in a return value) is reused here: these are generic, adapter-
// implementation-agnostic error classes an `XReadAdapter` implementation
// throws instead of ever silently returning an empty/successful result for
// a genuine failure. This is the "smallest additive design" identified for
// Stage 4A per instruction — flagged here, not silently added, and it does
// not change `XReadAdapter`, `ProfileResult`, `TweetResult`, `AccountResult`,
// or `XReadOptions` in any way.
//
// Never construct or catch XActions' own error classes outside
// `XActionsReadAdapter` — every implementation of `XReadAdapter` must throw
// one of these instead, so pipeline code never depends on which read
// implementation (XActions, a future fallback) is behind the interface.

export class XReadError extends Error {
  constructor(adapterName: string, method: string, reason: string, detail?: string) {
    super(`${adapterName}.${method}() ${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'XReadError';
  }
}

/** The request was rate-limited by X. Distinct from a genuine empty result. */
export class XReadRateLimitedError extends XReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'was rate-limited', detail);
    this.name = 'XReadRateLimitedError';
  }
}

/** Authentication/session was required or invalid for this read. Distinct from a genuine empty result. */
export class XReadAuthenticationRequiredError extends XReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'requires authentication or the current session is invalid', detail);
    this.name = 'XReadAuthenticationRequiredError';
  }
}

/** The target (profile/tweet) does not exist, is private, suspended, or deleted. Distinct from a genuine empty search result. */
export class XReadNotFoundError extends XReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'found no such profile/tweet (not found, private, suspended, or deleted)', detail);
    this.name = 'XReadNotFoundError';
  }
}

/** A network-level failure (connection, DNS, timeout) prevented the request from completing at all. */
export class XReadNetworkError extends XReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed due to a network error', detail);
    this.name = 'XReadNetworkError';
  }
}

/** An unexpected failure — a malformed/unrecognized upstream response shape, or any error not covered by the categories above. Never silently treated as an empty result. */
export class XReadUnexpectedError extends XReadError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed unexpectedly', detail);
    this.name = 'XReadUnexpectedError';
  }
}
