/**
 * XPublishAdapter — Stage 8 addition.
 *
 * Exactly one operation, and it is NOT a generic escape hatch: there is no
 * `request()`/`post()`/`execute()`/`publish(endpoint, payload)` method
 * here, and never will be — the only thing an implementation of this
 * interface can do is publish ONE text-only public X post. Mirrors
 * `XSendAdapter`'s (Stage 6B) exact narrow-contract discipline.
 *
 * Deliberately separate from `XWriteAdapter` (Stage 1, still an
 * unimplemented boundary stub) for the same reason `XSendAdapter` was kept
 * separate in Stage 6B: widening `XWriteAdapter` would force both of its
 * existing stub implementations to grow a method neither actually
 * implements, and this stage's real, verified implementation
 * (`XManagerPublishAdapter`, packages/adapters) needs its own narrow
 * contract rather than inheriting `XWriteAdapter`'s much larger,
 * still-unverified surface (`postThread`/`replyTo`/`sendDM`/
 * `getInboxSince`/`getSessionHealth`).
 *
 * See RISK_REGISTER.md's Stage 8 section and
 * `packages/adapters/vendor/x-manager-http/VENDOR.md` for the full
 * source-verification record (exact pinned commit, source path, endpoint,
 * payload, auth, response/error shapes).
 */

export interface PublishPostInput {
  text: string;
}

export interface PublishPostResult {
  /** X's own canonical numeric post ID, returned directly by the verified `POST /2/tweets` response body (`data.id`) — never fabricated, never derived. */
  xPostId: string;
  publishedAt: string;
  /** The exact text X reports back (`data.text`) — may legitimately differ from the request (e.g. platform-side URL shortening); preserved for traceability, never assumed identical to the input. */
  publishedText: string;
}

export interface XPublishAdapter {
  publishPost(input: PublishPostInput): Promise<PublishPostResult>;
}

// ---------------------------------------------------------------------------
// Publish-status error classes — mirrors XSendAdapter's (Stage 6B) exact
// design: generic, adapter-implementation-agnostic; an implementation never
// lets its own internal error types (X API error codes, HTTP client
// exceptions) escape this boundary.
// ---------------------------------------------------------------------------

export class XPublishError extends Error {
  constructor(adapterName: string, method: string, reason: string, detail?: string) {
    super(`${adapterName}.${method}() ${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'XPublishError';
  }
}

/** No valid OAuth1 user-context credentials are configured, or X rejected them (401, or a read-only-permissions app-scope error — see VENDOR.md). */
export class XPublishAuthenticationRequiredError extends XPublishError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'requires valid write-scoped X API credentials and none are configured (or the current credentials are invalid/read-only)', detail);
    this.name = 'XPublishAuthenticationRequiredError';
  }
}

export class XPublishRateLimitedError extends XPublishError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'was rate-limited', detail);
    this.name = 'XPublishRateLimitedError';
  }
}

/** X's API rejected the post content itself (e.g. exceeds the platform's own character limit, duplicate-content rule, or another platform-side content policy) — distinct from a transport/auth failure. */
export class XPublishInvalidContentError extends XPublishError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'was rejected by X for the content itself (length, duplicate-content rule, or another platform content policy)', detail);
    this.name = 'XPublishInvalidContentError';
  }
}

/** A network-level failure (connection, DNS, timeout) prevented the request from completing, OR completed but the response body could not be read — ambiguous: whether X actually created the post is UNKNOWN, never assumed to be either PUBLISHED or FAILED. */
export class XPublishNetworkError extends XPublishError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed due to a network error — whether X actually created the post is unknown', detail);
    this.name = 'XPublishNetworkError';
  }
}

/** An unexpected failure not covered by the categories above — a malformed/unrecognized response shape, or any error this taxonomy does not name. Never silently treated as a successful publish. */
export class XPublishUnexpectedError extends XPublishError {
  constructor(adapterName: string, method: string, detail?: string) {
    super(adapterName, method, 'failed unexpectedly', detail);
    this.name = 'XPublishUnexpectedError';
  }
}
