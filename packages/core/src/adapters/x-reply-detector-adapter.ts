/**
 * XReplyDetectorAdapter — Stage 6C addition (BUILD_PLAN.md "Stage 8 —
 * Outreach Engine", scoped here to read-only reply detection).
 *
 * Mirrors `XReadAdapter`'s and `XSendAdapter`'s exact discipline: a narrow,
 * single-purpose interface (one method), a generic implementation-agnostic
 * error taxonomy, and no generic escape hatch. This is a NEW, separate
 * contract rather than an extension of `XReadAdapter` — `XReadAdapter`'s
 * existing methods (`getProfile`, `searchTweets`, etc.) have nothing to do
 * with DM/conversation reading, and widening it would force
 * `XActionsReadAdapter` to grow an unrelated method, breaking that file's
 * zero-diff status since Stage 4A.
 *
 * Deliberately read-only and deliberately narrow: this contract exposes
 * exactly the one operation reply detection needs (fetch the observable
 * message history of a 1:1 DM conversation with a specific canonical X
 * user), never generic inbox/arbitrary-conversation access. Conversation
 * *discovery* (finding which X-side conversation, if any, corresponds to
 * a given user) is the implementation's concern, not part of this
 * contract's surface — callers only ever think in terms of "the target
 * user's canonical ID," never an X-native conversation ID, matching this
 * codebase's `prospects.x_user_id`-centric identity model throughout.
 */

export interface ConversationMessageObservation {
  /** X's own message identifier — the primary deduplication key wherever available (Stage 6C Section I). */
  xMessageId: string;
  /** The canonical X user ID that sent this message — never a username/display name. */
  senderXUserId: string;
  text: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface XReplyDetectorAdapter {
  /**
   * Returns every observable message in the 1:1 DM conversation with this
   * canonical X user ID, oldest-appropriate ordering as the underlying
   * platform provides it — or an empty array if no such conversation
   * exists yet (a legitimate "nothing observed," not a failure). Bounded
   * by the implementation (a single page of the platform's own inbox/
   * conversation listing) — never an unbounded crawl.
   */
  getConversationMessages(targetUserId: string): Promise<ConversationMessageObservation[]>;
}

// ---------------------------------------------------------------------------
// Read-status error classes — mirrors XReadAdapter's/XSendAdapter's Stage
// 4A/6B design exactly.
// ---------------------------------------------------------------------------

export class XReplyDetectorError extends Error {
  constructor(adapterName: string, method: string, reason: string, detail?: string) {
    super(`${adapterName}.${method}() ${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'XReplyDetectorError';
  }
}

export class XReplyDetectorAuthenticationRequiredError extends XReplyDetectorError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'requires an authenticated session and none is configured (or the current session is invalid)', detail);
    this.name = 'XReplyDetectorAuthenticationRequiredError';
  }
}

export class XReplyDetectorRateLimitedError extends XReplyDetectorError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'was rate-limited', detail);
    this.name = 'XReplyDetectorRateLimitedError';
  }
}

/** The target user's profile could not be resolved. Distinct from "no conversation exists yet," which is a legitimate empty result, not an error. */
export class XReplyDetectorNotFoundError extends XReplyDetectorError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'could not resolve the target user', detail);
    this.name = 'XReplyDetectorNotFoundError';
  }
}

export class XReplyDetectorNetworkError extends XReplyDetectorError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed due to a network error', detail);
    this.name = 'XReplyDetectorNetworkError';
  }
}

/** An unexpected failure not covered by the categories above — including a malformed/unrecognized response shape. Never silently treated as "no reply." */
export class XReplyDetectorUnexpectedError extends XReplyDetectorError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed unexpectedly', detail);
    this.name = 'XReplyDetectorUnexpectedError';
  }
}
