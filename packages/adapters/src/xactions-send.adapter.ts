import type { XSendAdapter, SendDirectMessageInput, SendDirectMessageResult } from '@metrivio/core';
import {
  KillSwitch,
  XSendAuthenticationRequiredError,
  XSendRateLimitedError,
  XSendNotFoundError,
  XSendNetworkError,
  XSendUnexpectedError,
} from '@metrivio/core';

import { TwitterHttpClient } from '../vendor/xactions-http/src/scrapers/twitter/http/client.js';
import { sendDM } from '../vendor/xactions-http/src/scrapers/twitter/http/dm.js';
import {
  TwitterApiError,
  RateLimitError,
  AuthError,
  NotFoundError,
  NetworkError,
} from '../vendor/xactions-http/src/scrapers/twitter/http/errors.js';

/**
 * XActions-backed implementation of `XSendAdapter` — Stage 6B-R.
 *
 * Stage 6B correctly refused to guess X's DM-send request format after
 * finding that the vendored XActions subtree deliberately excluded
 * `dm.js`. Stage 6B-R resolved that blocker by re-cloning upstream at the
 * *same already-pinned commit* and verifying `dm.js`'s `sendDM()` against
 * its own test suite (`tests/http-scraper/dm.test.js`) before vendoring a
 * trimmed excerpt of exactly that function — see
 * `packages/adapters/vendor/xactions-http/VENDOR.md`'s dedicated `dm.js`
 * section for the full source-verification record (request URL/body,
 * auth, target-identity, response shape, error behavior, licensing).
 *
 * This class mirrors `XActionsReadAdapter`'s exact structure: the kill
 * switch is checked first (identical to every other adapter in this
 * codebase), an authentication precondition is checked next (DM sending
 * has no guest-mode equivalent on X, unlike the read-only profile/search
 * paths — `requireAuth()` inside the vendored `sendDM()` would throw the
 * same underlying `AuthError` regardless, but checking it here first keeps
 * this adapter's own precondition explicit and matches the Stage 6B
 * behavior this class replaces), and every underlying XActions error is
 * mapped to the generic `XSend*Error` taxonomy before it ever leaves this
 * file — nothing vendor-specific escapes to `SendApprovedDraftService`.
 */
export interface XActionsSendAdapterOptions {
  killSwitch: KillSwitch;
  /** Cookie string (`auth_token=...; ct0=...`). Required for any real send attempt — DM sending has no guest-mode equivalent. Must come from the existing credential/encryption storage (DATABASE.md `credentials` table), never a plain environment variable read inline at call time. */
  sessionCookie?: string;
  /** Test-only escape hatch to inject a pre-built client instead of constructing one. Never used in production wiring. */
  client?: TwitterHttpClient;
}

/**
 * Maps XActions' own error hierarchy (never exposed outside this file) to
 * the generic `XSend*Error` classes every `XSendAdapter` implementation
 * must throw instead. Order matters — mirrors
 * `xactions-read.adapter.ts`'s `mapError` exactly: check the more specific
 * subclasses first (`RateLimitError`/`AuthError`/`NotFoundError`/
 * `NetworkError` all extend `TwitterApiError`).
 */
function mapError(adapterName: string, method: string, err: unknown): Error {
  if (err instanceof RateLimitError) {
    return new XSendRateLimitedError(adapterName, method, err.message);
  }
  if (err instanceof AuthError) {
    return new XSendAuthenticationRequiredError(adapterName, method, err.message);
  }
  if (err instanceof NotFoundError) {
    return new XSendNotFoundError(adapterName, method, err.message);
  }
  if (err instanceof NetworkError) {
    return new XSendNetworkError(adapterName, method, err.message);
  }
  if (err instanceof TwitterApiError) {
    // A generic/unclassified API error (e.g. a malformed/unrecognized
    // response shape) — never silently treated as a successful send.
    return new XSendUnexpectedError(adapterName, method, err.message);
  }
  return new XSendUnexpectedError(adapterName, method, err instanceof Error ? err.message : String(err));
}

export class XActionsSendAdapter implements XSendAdapter {
  private static readonly NAME = 'XActionsSendAdapter';
  private readonly killSwitch: KillSwitch;
  private readonly client: TwitterHttpClient;

  constructor(options: XActionsSendAdapterOptions) {
    this.killSwitch = options.killSwitch;
    this.client =
      options.client ??
      new TwitterHttpClient({
        cookies: options.sessionCookie || undefined,
        rateLimitStrategy: 'error',
      });
  }

  async sendDirectMessage(input: SendDirectMessageInput): Promise<SendDirectMessageResult> {
    await this.killSwitch.assertNotActive('x.write.sendDirectMessage');

    if (!this.client.isAuthenticated()) {
      throw new XSendAuthenticationRequiredError(XActionsSendAdapter.NAME, 'sendDirectMessage', 'no session cookie configured');
    }

    try {
      const result = await sendDM(this.client, input.targetUserId, input.messageText);
      return {
        xMessageId: result.messageId || undefined,
        sentAt: result.createdAt,
      };
    } catch (err) {
      throw mapError(XActionsSendAdapter.NAME, 'sendDirectMessage', err);
    }
  }
}
