import type { XPublishAdapter, PublishPostInput, PublishPostResult } from '@metrivio/core';
import {
  KillSwitch,
  XPublishAuthenticationRequiredError,
  XPublishRateLimitedError,
  XPublishInvalidContentError,
  XPublishNetworkError,
  XPublishUnexpectedError,
} from '@metrivio/core';

import { postTweetHttp, type PostTweetApiResponse } from '../vendor/x-manager-http/post-tweet.js';
import { buildOAuth1AuthorizationHeader, type OAuth1Credentials } from './oauth1-signer.js';

/**
 * XManagerPublishAdapter — Stage 8's real, verified `XPublishAdapter`
 * implementation.
 *
 * Wires `packages/adapters/vendor/x-manager-http/post-tweet.js` (the
 * verified `POST /2/tweets` request/response logic, trimmed from
 * `tylerbuilds/x-manager`'s own vendored snapshot — see that directory's
 * VENDOR.md for the full source-verification record) together with
 * `oauth1-signer.ts` (this repository's own from-scratch OAuth 1.0a
 * signer, chosen over adding the verified source's own `oauth-1.0a` +
 * `crypto-js` dependencies).
 *
 * Mirrors `XActionsSendAdapter`'s exact structure: kill switch checked
 * first, credentials accepted only via constructor options (never a plain
 * environment-variable read inline at call time — must come from the
 * existing credential/encryption storage per DATABASE.md's `credentials`
 * table), and every vendor/HTTP-level error mapped to the generic
 * `XPublish*Error` taxonomy before it ever leaves this file.
 */
export interface XManagerPublishAdapterOptions {
  killSwitch: KillSwitch;
  /** OAuth 1.0a user-context credentials. Must come from the existing credential/encryption storage, never a plain environment variable read inline at call time. Required for any real publish attempt. */
  credentials?: OAuth1Credentials;
  /** e.g. "https://api.x.com" — the verified default is `DEFAULT_X_API_BASE_URL` per `packages/adapters/vendor/x-manager-http/VENDOR.md`; injectable for tests, never guessed at call time. */
  baseUrl?: string;
  /** Test-only escape hatch to inject a fake `fetch`-backed transport instead of the real vendored `postTweetHttp`. Never used in production wiring. */
  postTweetHttpImpl?: typeof postTweetHttp;
}

const DEFAULT_X_API_BASE_URL = 'https://api.x.com';

function mapFailure(adapterName: string, method: string, response: PostTweetApiResponse): Error {
  const errorMessage = response.errors?.map((e) => e.message).join('; ') || undefined;
  const errorType = response.errors?.[0]?.type;

  // No httpStatus at all means postTweetHttp's own fetch-level try/catch
  // fired (a genuine network failure) — whether X actually created the post
  // is unknown, never assumed FAILED.
  if (response.httpStatus === undefined || errorType === 'network_error') {
    return new XPublishNetworkError(adapterName, method, errorMessage);
  }

  if (response.httpStatus === 429) {
    return new XPublishRateLimitedError(adapterName, method, errorMessage);
  }

  if (response.httpStatus === 401 || response.httpStatus === 403) {
    return new XPublishAuthenticationRequiredError(adapterName, method, errorMessage);
  }

  if (response.httpStatus === 400 || response.httpStatus === 422) {
    return new XPublishInvalidContentError(adapterName, method, errorMessage);
  }

  // Any other status (5xx, or an unrecognized 4xx) — a real HTTP response
  // was received, so this is not a network-ambiguous case, but it is also
  // not one of the specifically-classified categories above.
  return new XPublishUnexpectedError(adapterName, method, errorMessage);
}

export class XManagerPublishAdapter implements XPublishAdapter {
  private static readonly NAME = 'XManagerPublishAdapter';
  private readonly killSwitch: KillSwitch;
  private readonly credentials?: OAuth1Credentials;
  private readonly baseUrl: string;
  private readonly postTweetHttpImpl: typeof postTweetHttp;

  constructor(options: XManagerPublishAdapterOptions) {
    this.killSwitch = options.killSwitch;
    this.credentials = options.credentials;
    this.baseUrl = options.baseUrl ?? DEFAULT_X_API_BASE_URL;
    this.postTweetHttpImpl = options.postTweetHttpImpl ?? postTweetHttp;
  }

  async publishPost(input: PublishPostInput): Promise<PublishPostResult> {
    await this.killSwitch.assertNotActive('x.publish.publishPost');

    if (!this.credentials) {
      throw new XPublishAuthenticationRequiredError(XManagerPublishAdapter.NAME, 'publishPost', 'no OAuth1 credentials configured');
    }

    const authorizationHeader = buildOAuth1AuthorizationHeader({
      method: 'POST',
      url: `${this.baseUrl}/2/tweets`,
      credentials: this.credentials,
    });

    let response: PostTweetApiResponse;
    try {
      response = await this.postTweetHttpImpl(this.baseUrl, authorizationHeader, input.text);
    } catch (err) {
      // postTweetHttp itself never throws (it catches its own fetch
      // rejection and returns a network_error shape) — but never let an
      // unexpected throw from a test double or future change escape
      // unmapped either.
      throw new XPublishUnexpectedError(XManagerPublishAdapter.NAME, 'publishPost', err instanceof Error ? err.message : String(err));
    }

    if (response.errors && response.errors.length > 0) {
      throw mapFailure(XManagerPublishAdapter.NAME, 'publishPost', response);
    }

    if (!response.data?.id) {
      throw new XPublishUnexpectedError(XManagerPublishAdapter.NAME, 'publishPost', 'X API returned no post ID and no error');
    }

    return {
      xPostId: response.data.id,
      publishedAt: new Date().toISOString(),
      publishedText: response.data.text || input.text,
    };
  }
}
