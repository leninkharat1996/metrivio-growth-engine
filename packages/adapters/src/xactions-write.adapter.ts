import type { XWriteAdapter, XWriteOptions, PostResult, DMResult, InboxItem, SessionHealthResult } from '@metrivio/core';
import { NotImplementedInStage1Error } from './not-implemented.js';

/**
 * XActions-backed implementation of XWriteAdapter — the session-based write
 * path, which per ARCHITECTURE.md §6 owns `sendDM` specifically (official-API
 * DM access typically requires an elevated X API tier unlikely to be
 * available at Metrivio's founding-client stage — RESEARCH.md §5 point 2).
 * `postTweet`/`postThread`/`replyTo` are also implemented here so this class
 * is a complete, drop-in XWriteAdapter on its own (e.g. if the founder
 * prefers to route everything through one adapter instead of two), even
 * though XManagerWriteAdapter is the default owner of those three per
 * ARCHITECTURE.md.
 *
 * Every call through this adapter is intended to be subject to the Session
 * Health Monitor and the configured automation_mode (ARCHITECTURE.md §6) —
 * that wiring happens in Stage 8's pipeline/service layer, not inside this
 * Stage 1 stub.
 *
 * Stage 1 boundary only: no XActions session cookie is read, no network
 * request is made, and no account is touched. Every method throws.
 */
export class XActionsWriteAdapter implements XWriteAdapter {
  private static readonly NAME = 'XActionsWriteAdapter';

  async postTweet(_content: string, _opts?: XWriteOptions): Promise<PostResult> {
    throw new NotImplementedInStage1Error(XActionsWriteAdapter.NAME, 'postTweet');
  }

  async postThread(_contents: string[], _opts?: XWriteOptions): Promise<PostResult[]> {
    throw new NotImplementedInStage1Error(XActionsWriteAdapter.NAME, 'postThread');
  }

  async sendDM(_handle: string, _content: string, _opts?: XWriteOptions): Promise<DMResult> {
    throw new NotImplementedInStage1Error(XActionsWriteAdapter.NAME, 'sendDM');
  }

  async replyTo(_tweetId: string, _content: string, _opts?: XWriteOptions): Promise<PostResult> {
    throw new NotImplementedInStage1Error(XActionsWriteAdapter.NAME, 'replyTo');
  }

  async getInboxSince(_timestamp: string): Promise<InboxItem[]> {
    throw new NotImplementedInStage1Error(XActionsWriteAdapter.NAME, 'getInboxSince');
  }

  async getSessionHealth(): Promise<SessionHealthResult> {
    throw new NotImplementedInStage1Error(XActionsWriteAdapter.NAME, 'getSessionHealth');
  }
}
