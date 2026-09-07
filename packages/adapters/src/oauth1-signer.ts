import { createHmac, randomBytes } from 'node:crypto';

/**
 * Original, native OAuth 1.0a HMAC-SHA1 request-signing implementation
 * (RFC 5849) — used by `XManagerPublishAdapter` to authenticate the
 * verified `POST /2/tweets` call (see
 * `packages/adapters/vendor/x-manager-http/VENDOR.md`).
 *
 * Deliberately NOT vendored from the verified source's own dependencies
 * (`oauth-1.0a` + `crypto-js`, both zero-dependency packages the real
 * `twitter-api-client.ts` uses) — per Stage 8's "prefer ZERO new external
 * dependencies" instruction, this reimplements the same standardized,
 * publicly documented IETF algorithm using only Node's built-in `crypto`
 * module. This is a reimplementation of a stable, decades-old signing
 * spec, not a guess at an undocumented X-specific request format — the
 * verified source's own request/response/error handling (endpoint,
 * payload, response shape) is the part that genuinely required source
 * verification and IS vendored (see `post-tweet.js`). The verified
 * source's `generateOAuthHeaders()` comment ("For Twitter API v2, do NOT
 * include the request body in the OAuth signature") is followed exactly
 * here: only `oauth_*` parameters are included in the signature base
 * string, never the JSON body or any query parameter.
 */
export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** RFC 3986 percent-encoding — stricter than `encodeURIComponent` (also encodes `!*'()`), exactly as OAuth 1.0a requires. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildParamString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] as string)}`)
    .join('&');
}

export interface BuildAuthorizationHeaderOptions {
  method: string;
  url: string;
  credentials: OAuth1Credentials;
  /** Injectable for deterministic tests — never read from `Date.now()`/`crypto.randomBytes()` directly in a test assertion. */
  timestampSeconds?: number;
  nonce?: string;
}

export function buildOAuth1AuthorizationHeader(options: BuildAuthorizationHeaderOptions): string {
  const { method, url, credentials } = options;
  const timestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(16).toString('hex');

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };

  // Per the verified source's own documented behavior: for a JSON POST body
  // against a v2 endpoint, the body is NEVER included in the signature base
  // string — only the oauth_* parameters (no query string here either).
  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(buildParamString(oauthParams))].join('&');
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const header = Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key] as string)}"`)
    .join(', ');

  return `OAuth ${header}`;
}
