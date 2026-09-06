/**
 * XSendAdapter — Stage 6B addition (BUILD_PLAN.md "Stage 8 — Outreach
 * Engine", scoped here to the single, explicit, human-approved DM send
 * this stage's instructions define).
 *
 * Deliberately a NEW, narrow interface rather than an extension of the
 * existing `XWriteAdapter` (Stage 1): `XWriteAdapter.sendDM(handle, ...)`
 * targets a prospect by *username*, which this stage's instructions
 * explicitly reject as insufficient ("must use the canonical X user ID
 * whenever available... do not rely solely on username"). Widening
 * `XWriteAdapter` itself would also force both of its existing
 * implementations (`XActionsWriteAdapter`, `XManagerWriteAdapter`, both
 * untouched since Stage 1) to grow a new method they don't need — a
 * separate, purpose-built contract keeps those files at zero diff.
 *
 * Exactly one operation, and it is NOT a generic escape hatch: there is no
 * `request()`/`post()`/`execute()` method here, and never will be — the
 * only thing an implementation of this interface can do is send one DM to
 * one canonical user ID. See RISK_REGISTER.md's Stage 6B section for why
 * the concrete implementation (`XActionsSendAdapter`,
 * packages/adapters/src/xactions-send.adapter.ts) does not yet perform a
 * real network write: the vendored XActions subtree deliberately excludes
 * `dm.js` (VENDOR.md's own "Deliberately NOT vendored" list), so no
 * verified request-body format exists for X's DM-send endpoint, and this
 * codebase does not invent one.
 */

export interface SendDirectMessageInput {
  /** X's own immutable numeric user ID — never a username/handle. */
  targetUserId: string;
  messageText: string;
}

export interface SendDirectMessageResult {
  /** X's own message identifier, when the platform returns one. */
  xMessageId?: string;
  sentAt: string;
}

export interface XSendAdapter {
  sendDirectMessage(input: SendDirectMessageInput): Promise<SendDirectMessageResult>;
}

// ---------------------------------------------------------------------------
// Send-status error classes — mirrors XReadAdapter's Stage 4A design exactly
// (generic, adapter-implementation-agnostic; an implementation never lets
// its own internal error types escape this boundary).
// ---------------------------------------------------------------------------

export class XSendError extends Error {
  constructor(adapterName: string, method: string, reason: string, detail?: string) {
    super(`${adapterName}.${method}() ${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'XSendError';
  }
}

/** No valid authenticated session is configured. DM sending always requires an authenticated session — there is no guest-mode DM send, unlike the read-only profile/search paths. */
export class XSendAuthenticationRequiredError extends XSendError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'requires an authenticated session and none is configured (or the current session is invalid)', detail);
    this.name = 'XSendAuthenticationRequiredError';
  }
}

export class XSendRateLimitedError extends XSendError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'was rate-limited', detail);
    this.name = 'XSendRateLimitedError';
  }
}

/** The target user does not exist, is not reachable via DM (e.g. does not follow back / has DMs restricted), or was suspended/deleted. */
export class XSendNotFoundError extends XSendError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'could not reach the target user (not found, suspended, or DMs restricted)', detail);
    this.name = 'XSendNotFoundError';
  }
}

/** A network-level failure (connection, DNS, timeout) prevented the request from completing at all — ambiguous: delivery status to X is unknown. */
export class XSendNetworkError extends XSendError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed due to a network error', detail);
    this.name = 'XSendNetworkError';
  }
}

/**
 * An unexpected failure not covered by the categories above — including,
 * currently, every real send attempt: `XActionsSendAdapter` always throws
 * this (never silently returns a fabricated success) because no verified
 * request format exists yet. See this file's top doc comment.
 */
export class XSendUnexpectedError extends XSendError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed unexpectedly', detail);
    this.name = 'XSendUnexpectedError';
  }
}
