import type { SessionHealthState } from '../automation/types.js';

/**
 * XWriteAdapter — ARCHITECTURE.md §6.
 *
 * Two implementations sit behind this one interface (ARCHITECTURE.md §6):
 *  - XManagerWriteAdapter (official X API, via the vendored X-Manager Bridge
 *    API) for postTweet/postThread/replyTo/scheduling.
 *  - XActionsWriteAdapter (session-based) for sendDM.
 *
 * Every call is subject to the kill switch, the configured automation_mode,
 * daily/action limits, and the Session Health Monitor — those checks live in
 * the pipeline/service layer that calls this adapter (Stage 8), not inside
 * the adapter implementations themselves, so the same guard logic applies
 * uniformly regardless of which concrete adapter handles a given action.
 *
 * This file defines the contract only. Stage 1 does not implement production
 * network calls against it (see packages/adapters for the Stage 1 stub) —
 * per instruction #15, no actual outbound automation exists yet.
 */

export interface PostResult {
  id: string;
  url: string;
  postedAt: string;
}

export interface DMResult {
  id: string;
  sentAt: string;
}

export interface InboxItem {
  id: string;
  type: 'mention' | 'dm' | 'reply';
  fromUsername: string;
  content: string;
  receivedAt: string;
}

export interface SessionHealthResult {
  state: SessionHealthState;
  recentErrorRate: number;
  authFailureCount24h: number;
  rateLimitHeadroom?: Record<string, unknown>;
  timeSinceLastSuccessSeconds?: number;
}

export interface XWriteOptions {
  dryRun?: boolean;
}

export interface XWriteAdapter {
  postTweet(content: string, opts?: XWriteOptions): Promise<PostResult>;
  postThread(contents: string[], opts?: XWriteOptions): Promise<PostResult[]>;
  sendDM(handle: string, content: string, opts?: XWriteOptions): Promise<DMResult>;
  replyTo(tweetId: string, content: string, opts?: XWriteOptions): Promise<PostResult>;
  /** Mentions/DMs/replies since a given timestamp — feeds Reply Detection (ARCHITECTURE.md §3.1). */
  getInboxSince(timestamp: string): Promise<InboxItem[]>;
  /** Feeds the Session Health Monitor (ARCHITECTURE.md §3.5). */
  getSessionHealth(): Promise<SessionHealthResult>;
}
