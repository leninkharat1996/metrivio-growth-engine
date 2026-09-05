// Hand-authored by Metrivio — NOT part of the upstream xactions snapshot.
// See VENDOR.md "Hand-authored TypeScript declarations" for why this exists
// and what must be reviewed when the vendor pin is bumped.
import type { TwitterHttpClient } from './client.js';

/** Shape produced by parse/user.js#parseUserData — verified by direct source inspection. */
export interface RawXProfile {
  id: string | null;
  name: string;
  username: string;
  bio: string;
  location: string;
  website: string | null;
  joined: string | null;
  birthday: string | null;
  following: number;
  followers: number;
  tweets: number;
  likes: number;
  media: number;
  avatar: string | null;
  header: string | null;
  verified: boolean;
  protected: boolean;
  pinnedTweetId: string | null;
  bioEntities: { urls: unknown[]; hashtags: unknown[]; mentions: unknown[] };
  platform: 'twitter';
}

export function scrapeProfile(client: TwitterHttpClient, username: string): Promise<RawXProfile>;
export function scrapeProfileById(client: TwitterHttpClient, userId: string): Promise<RawXProfile>;
export function parseUserData(rawUser: unknown): RawXProfile;
