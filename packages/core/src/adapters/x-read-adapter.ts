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
