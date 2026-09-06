import type { XSendAdapter, SendDirectMessageInput, SendDirectMessageResult } from '@metrivio/core';
import {
  KillSwitch,
  XSendAuthenticationRequiredError,
  XSendUnexpectedError,
} from '@metrivio/core';

import { TwitterHttpClient } from '../vendor/xactions-http/src/scrapers/twitter/http/client.js';

/**
 * XActions-backed implementation of `XSendAdapter` — Stage 6B.
 *
 * **Does not yet perform a real X network write.** This is a deliberate,
 * researched decision, not an oversight — see the "CRITICAL: X WRITE
 * IMPLEMENTATION RESEARCH" finding this stage's instructions required
 * before writing any code:
 *
 *   - The vendored XActions subtree (`packages/adapters/vendor/xactions-http/`)
 *     deliberately excludes `dm.js` — VENDOR.md's own "Deliberately NOT
 *     vendored" list names it explicitly, alongside `actions.js`/
 *     `engagement.js`/`media.js`, as a write/mutation path out of Stage
 *     4A's read-only scope.
 *   - `endpoints.js` (vendored wholesale because `client.js`/`profile.js`/
 *     `search.js`/`tweets.js` all import shared constants from it) happens
 *     to carry the bare REST path string `REST.dmNew = '/1.1/dm/new2.json'`
 *     — but a path string is not a request format. The actual JSON/form
 *     body shape X's DM-send endpoint requires (recipient/conversation
 *     addressing, any required companion fields) lives in upstream's
 *     `dm.js`, which was never vendored, so it is not verified anywhere in
 *     this codebase.
 *   - Per instruction, inventing that request format rather than sourcing
 *     it from verified code would risk a malformed request (at best, an
 *     immediate rejection; at worst, behavior indistinguishable from
 *     automation abuse to X's own systems) — exactly the "speculative X
 *     write protocol" this stage was told to stop short of.
 *
 * What this class DOES do for real: kill-switch gating (identical to
 * every other adapter in this codebase) and an authentication
 * precondition check (`TwitterHttpClient.isAuthenticated()`) — DM sending
 * has no guest-mode equivalent on X, unlike the read-only profile/search
 * paths, so a request with no authenticated session is refused before
 * anything else, independent of the capability gap above. Once a future
 * stage vendors (or independently, carefully re-implements from verified
 * source) the actual DM request format, only this file's final branch
 * needs to change — the kill-switch/auth-precondition/error-mapping
 * scaffolding around it is already correct and already tested.
 */
export interface XActionsSendAdapterOptions {
  killSwitch: KillSwitch;
  /** Cookie string (`auth_token=...; ct0=...`). Required for any real send attempt — see the class doc comment. Must come from the existing credential/encryption storage (DATABASE.md `credentials` table), never a plain environment variable read inline at call time. */
  sessionCookie?: string;
  /** Test-only escape hatch to inject a pre-built client instead of constructing one. Never used in production wiring. */
  client?: TwitterHttpClient;
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

    // See this class's doc comment: no verified request format exists for
    // X's DM-send endpoint in this codebase's vendored source. Refuses
    // rather than guesses.
    void input;
    throw new XSendUnexpectedError(
      XActionsSendAdapter.NAME,
      'sendDirectMessage',
      'no verified DM request format is available (dm.js was deliberately excluded from the vendored XActions subtree — see VENDOR.md and RISK_REGISTER.md Stage 6B); refusing to send a speculative/invented request rather than risk a malformed write'
    );
  }
}
