// Hand-authored by Metrivio — NOT part of the upstream xactions snapshot.
// See VENDOR.md "Hand-authored TypeScript declarations" for why this exists
// and what must be reviewed when the vendor pin is bumped.
import type { TwitterHttpClient } from './client.js';

/** Shape produced by parse/tweet.js#parseTweetData — verified by direct source inspection. */
export interface RawXTweet {
  id: string | null;
  text: string;
  createdAt: string | null;
  author: {
    id: string | null;
    username: string;
    name: string;
    avatar: string | null;
    verified: boolean;
  };
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    bookmarks: number;
    views: number;
  };
  media: unknown[];
  quotedTweet: RawXTweet | null;
  inReplyTo: { tweetId: string; userId: string | null; username: string | null } | null;
  urls: unknown[];
  hashtags: string[];
  mentions: unknown[];
  isReply: boolean;
  isRetweet: boolean;
  retweetOf: RawXTweet | null;
  lang: string | null;
  source: string | null;
  platform: 'twitter';
  /** Only present for tombstoned (deleted/withheld) tweets. */
  tombstone?: boolean;
}

export interface SearchTweetsOptions {
  limit?: number;
  type?: 'Top' | 'Latest' | 'Photos' | 'Videos';
  cursor?: string | null;
  onProgress?: (progress: { fetched: number; limit: number }) => void;
  since?: string;
  until?: string;
  from?: string;
  to?: string;
  minLikes?: number;
  minRetweets?: number;
  lang?: string;
  filter?: string;
}

export function searchTweets(client: TwitterHttpClient, query: string, options?: SearchTweetsOptions): Promise<RawXTweet[]>;
export function searchUsers(client: TwitterHttpClient, query: string, options?: { limit?: number; cursor?: string | null }): Promise<unknown[]>;
