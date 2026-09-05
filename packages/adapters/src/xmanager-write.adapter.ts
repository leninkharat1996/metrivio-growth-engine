import type { XWriteAdapter, XWriteOptions, PostResult, DMResult, InboxItem, SessionHealthResult } from '@metrivio/core';
import { NotImplementedInStage1Error } from './not-implemented.js';

/**
 * X-Manager-backed implementation of XWriteAdapter — the official-X-API path
 * for posting, threading, replying, and scheduling (RESEARCH.md §3,
 * ARCHITECTURE.md §6). Per ARCHITECTURE.md, this adapter owns `postTweet`,
 * `postThread`, and `replyTo`; `sendDM` is owned by XActionsWriteAdapter
 * instead (official-API DM access typically requires an elevated tier).
 * Which concrete adapter handles which action type is a routing decision for
 * the pipeline/service layer built in Stage 8 — this class still implements
 * the full interface so it's a drop-in XWriteAdapter on its own if that
 * routing ever changes.
 *
 * Stage 1 boundary only: no calls are made to a vendored X-Manager instance,
 * no Bridge API token is required, and nothing here touches a real X
 * account. Every method throws, consistent with instruction #15 ("do not
 * implement actual outbound automation yet"). Stage 2 replaces these bodies
 * with real Bridge API calls against the vendored, pinned X-Manager fork.
 */
export class XManagerWriteAdapter implements XWriteAdapter {
  private static readonly NAME = 'XManagerWriteAdapter';

  async postTweet(_content: string, _opts?: XWriteOptions): Promise<PostResult> {
    throw new NotImplementedInStage1Error(XManagerWriteAdapter.NAME, 'postTweet');
  }

  async postThread(_contents: string[], _opts?: XWriteOptions): Promise<PostResult[]> {
    throw new NotImplementedInStage1Error(XManagerWriteAdapter.NAME, 'postThread');
  }

  async sendDM(_handle: string, _content: string, _opts?: XWriteOptions): Promise<DMResult> {
    // Deliberately not this adapter's owned action per ARCHITECTURE.md §6,
    // but still throws the same Stage 1 boundary error rather than a
    // different "wrong adapter" error, since routing logic doesn't exist
    // yet either (that's Stage 8).
    throw new NotImplementedInStage1Error(XManagerWriteAdapter.NAME, 'sendDM');
  }

  async replyTo(_tweetId: string, _content: string, _opts?: XWriteOptions): Promise<PostResult> {
    throw new NotImplementedInStage1Error(XManagerWriteAdapter.NAME, 'replyTo');
  }

  async getInboxSince(_timestamp: string): Promise<InboxItem[]> {
    throw new NotImplementedInStage1Error(XManagerWriteAdapter.NAME, 'getInboxSince');
  }

  async getSessionHealth(): Promise<SessionHealthResult> {
    throw new NotImplementedInStage1Error(XManagerWriteAdapter.NAME, 'getSessionHealth');
  }
}
