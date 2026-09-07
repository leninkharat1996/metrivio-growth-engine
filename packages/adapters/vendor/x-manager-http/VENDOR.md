# Vendored (trimmed excerpt): tylerbuilds/x-manager — `POST /2/tweets` request/response logic

**Vendored per this repository's Stage 8 instructions:** "Research upstream transport before code — do
not guess or infer the endpoint or payload." This directory is the result of that research: the exact
verified request/response/error-handling logic of X's own real, working public-post-publishing
transport, trimmed out of the already-vendored full `x-manager` snapshot (`packages/content/vendor/x-manager`)
so this package can use it without pulling in x-manager's own separate Next.js/Drizzle app (see "Why a
trimmed excerpt, not an import" below).

- **Source:** https://github.com/tylerbuilds/x-manager
- **Pinned commit:** `a3534ba953fc88beac79fc12ca5ebbcd4f3bed2d` (the same pin already used for
  `packages/content/vendor/x-manager`, re-verified for this excerpt — see below).
- **Pinned version (package.json):** `0.2.0`
- **Source file excerpted from:** `src/lib/twitter-api-client.ts`, function `postTweet` (lines 146-239 at
  the pinned commit) and its private helpers `asRecord`/`asString`/`uniqueMessages`/`normalizeErrorResponse`
  (lines 29-92).
- **Vendored on:** 2026-09-06.
- **License:** MIT (see `LICENSE` in this directory — copied unmodified from
  `packages/content/vendor/x-manager/LICENSE`, same upstream repository).
- **Verification performed this session:** a fresh `git clone` of `tylerbuilds/x-manager` followed by
  `git checkout a3534ba953fc88beac79fc12ca5ebbcd4f3bed2d`, confirmed via `git rev-parse HEAD` to match
  the pin exactly, then `diff -q` of `src/lib/twitter-api-client.ts` (and `src/app/api/bridge/openclaw/post/route.ts`,
  `src/lib/x-config.ts`, `package.json`) against the already-vendored copies in
  `packages/content/vendor/x-manager` — **all four returned no differences (byte-identical)**, confirming
  the whole-repo snapshot this excerpt is trimmed from is itself genuine and unmodified. This is the same
  verification discipline `packages/adapters/vendor/xactions-http/VENDOR.md` documents for its own
  trimmed `dm.js` excerpt.
- **Endpoint (verified from source, not guessed):** `POST {xApiBaseUrl}/2/tweets`, where upstream's own
  `x-config.ts` resolves `xApiBaseUrl` to `DEFAULT_X_API_BASE_URL = 'https://api.x.com'` unless overridden
  — this is the official, documented X API v2 tweet-creation endpoint, not an internal/undocumented
  scraper endpoint (contrast with `packages/adapters/vendor/xactions-http`, which does scrape X's internal
  GraphQL API for read operations).
- **Payload (verified from source):** `{"text": string}` for a text-only post — upstream's own
  `PostTweetRequest` type additionally supports `media`, `community_id`, and `reply.in_reply_to_tweet_id`,
  all three of which are **deliberately excluded from this excerpt** per Stage 8's text-only-public-post
  scope (see RISK_REGISTER.md §2L).
- **Authentication (verified from source):** OAuth 1.0a user-context, `Authorization: OAuth ...` header,
  generated per-request over the method + URL + `oauth_*` parameters only — **the JSON body is
  deliberately never included in the OAuth1 signature base string**, per upstream's own explicit code
  comment ("For Twitter API v2, do NOT include the request body in the OAuth signature — The body should
  only be included for v1.1 endpoints with form-encoded data", `twitter-api-client.ts` lines 135-136).
  This excerpt does not generate the header itself (see below) but its request logic assumes exactly this
  header shape, matching upstream's own `generateOAuthHeaders`.
- **Response shape (verified from source):** success → `{"data": {"id": string, "text": string}}`;
  failure → `{"errors": [{"message": string, "type"?: string}]}`, normalized from whatever shape X's API
  actually returned (a `detail`/`title` JSON:API-style problem body, a bare error array, or an unparseable
  body) by upstream's own `normalizeErrorResponse` — vendored here byte-for-byte in logic.
- **Character limit (Stage 8 §P — verified, not invented):** upstream's own bridge layer
  (`src/app/api/bridge/openclaw/post/route.ts` line 19) defines `MAX_TWEET_CHARS = 280` and checks it via
  `twitterWeightedLength()` (`src/lib/twitter-text.ts`), which implements X's own documented
  character-counting rule (https://developer.x.com/en/docs/counting-characters): every `http(s)://` URL in
  the text is weighted as exactly 23 characters regardless of its real length, and all other characters
  count 1-for-1. **This 280 limit is X's own platform-wide standard tweet length limit for OAuth1
  user-context posts** (X's core platform limit; it is not a client-invented number) — see
  `packages/content/src/publishing/x-post-constraints.ts` for where this repository's own validation
  applies it. This excerpt itself does not enforce the limit (that is done by the caller, before ever
  reaching this transport code, so a rejected post never wastes a network round-trip) — X's own API would
  also reject an over-length post server-side as a content error, which `normalizeErrorResponse` would
  surface as an `errors[]` entry.

## Why a trimmed excerpt, not a direct import of `packages/content/vendor/x-manager`

`twitter-api-client.ts`'s own `postTweet` calls `resolveConfig()` → `getResolvedXConfig()`
(`src/lib/x-config.ts`), which falls back to `getAppSettings()` (`src/lib/app-settings.ts`) when no
environment variable is set — and `app-settings.ts` imports `./db`, x-manager's own **separate**
Next.js/Drizzle database module (a completely different schema/connection than
`packages/core`'s `MetrivioDb`). Importing `postTweet` directly would transitively pull that unrelated
database/app-settings machinery into `packages/adapters`, which is neither necessary nor safe (it would
create a second, parallel, unused database connection path). Trimming out just the request/response/
error-handling logic — the part that is genuinely X-API-specific and required real source verification —
and replacing the OAuth-header-generation and config-resolution calls with injected parameters avoids
this, exactly mirroring the reasoning already documented in
`packages/adapters/vendor/xactions-http/VENDOR.md`'s "Why only these files" section for the read-scraper
subtree.

## Files vendored (exact list)

```
post-tweet.js   — postTweetHttp (adapted from postTweet) + normalizeErrorResponse/asRecord/asString/uniqueMessages (byte-identical logic, TS -> plain JS)
post-tweet.d.ts — hand-authored TypeScript declarations (see below)
LICENSE         — copied unmodified from packages/content/vendor/x-manager/LICENSE (same upstream repo, MIT)
```

## What was changed from upstream (exhaustive list — this is NOT a byte-identical vendor)

1. **OAuth header generation removed.** Upstream's `createOAuthClient`/`generateOAuthHeaders` (which use
   the `oauth-1.0a` + `crypto-js` npm packages, confirmed NOT installed anywhere in this repository) are
   not reproduced. `postTweetHttp(baseUrl, authorizationHeader, text)` instead accepts an already-built
   `Authorization` header string as a parameter, produced by
   `packages/adapters/src/oauth1-signer.ts` — an original, from-scratch reimplementation of the standard
   OAuth 1.0a (RFC 5849) algorithm using only Node's built-in `crypto` module, chosen specifically to avoid
   adding `oauth-1.0a`/`crypto-js` as new dependencies (see that file's own doc comment for the full
   reasoning). This is a functional-equivalence reimplementation of a public, standardized algorithm, not
   a guess at X's own undocumented request format — the request/response logic in this directory (the
   part that genuinely needed source verification) is untouched.
2. **Config resolution removed.** Upstream's `resolveConfig`/`getResolvedXConfig` are not reproduced.
   `postTweetHttp` accepts `baseUrl` as a parameter instead of resolving it internally.
3. **`media`, `community_id`, `reply` payload fields removed.** Stage 8's scope is text-only public posts
   (see RISK_REGISTER.md §2L for the full scope justification) — these fields, and the corresponding
   `mediaIds`/`communityId`/`replyToTweetId` parameters of upstream's `postTweet`, are not present here.
4. **Diagnostic `console.error` logging on failure removed.** Upstream logs the response status, headers,
   and body on a non-OK response. This excerpt never logs request/response bodies or headers, since a
   future caller could pass through data (e.g. a future config field) that this file cannot itself
   guarantee is credential-free — the caller (`XManagerPublishAdapter`) is responsible for constructing
   only the narrow, audit-safe log entries Stage 8 requires (draft ID, X post ID if known, operation,
   result, error category, timestamp — never headers, never credentials).
5. **Return shape carries `httpStatus`.** Added so the calling adapter can distinguish, e.g., a 401 from a
   429 from a 5xx without re-parsing `normalizeErrorResponse`'s `type` string — upstream's own `postTweet`
   discards the status code once it has produced the normalized error shape.

Everything else — the endpoint URL construction, the JSON request body shape (for the `text`-only case),
reading the raw response body as text before attempting `JSON.parse`, the `{detail: rawBody}` fallback on
parse failure, and all of `normalizeErrorResponse`'s message-extraction logic (including the specific
read-only-permissions hint) — is preserved with identical behavior.

## Hand-authored TypeScript declarations (NOT part of the upstream snapshot)

`post-tweet.d.ts` was written by us, not copied from upstream (upstream ships plain TypeScript compiled
to JS via Next.js, not a hand-maintained `.d.ts` boundary). It declares only the narrow surface
`packages/adapters/src/xmanager-publish.adapter.ts` actually consumes. If the pin is ever bumped, this
file must be manually reviewed against the new upstream `twitter-api-client.ts` types.

## Update procedure

1. Re-clone `tylerbuilds/x-manager` at the desired newer commit.
2. Diff the new `src/lib/twitter-api-client.ts`'s `postTweet`/`normalizeErrorResponse`/`asRecord`/
   `asString`/`uniqueMessages` against `post-tweet.js`, applying the same five changes listed above.
3. Re-verify the endpoint, payload shape, auth header comment, and response shape assertions above still
   hold (especially the "do NOT include the request body in the OAuth signature" comment, which
   `oauth1-signer.ts` depends on).
4. Re-check `src/lib/twitter-text.ts`'s `MAX_TWEET_CHARS`/`twitterWeightedLength` for any change to the
   280-character limit or its weighting rule.
5. Update the pinned commit/version at the top of this file.
6. Re-run `packages/adapters/test/xmanager-publish.adapter.test.ts` (all fixtures are based on this
   verified response shape, not live calls, so they will catch a shape change here).

## Known upstream risk considerations (see also RISK_REGISTER.md §2L)

- **No automatic retry on `postTweet` itself** (unlike some other endpoints in the same upstream file,
  which do retry on 429/5xx via a separate `signedJsonRequest` helper this excerpt does not use) — a
  single network-level failure surfaces immediately as an ambiguous outcome. This is the exact reason
  Stage 8's `PublishResult` includes an explicit `UNKNOWN` outcome and the `XPublishNetworkError` error
  class is documented as "whether X actually created the post is unknown," rather than the automation
  layer silently retrying (which could duplicate a post X already accepted).
- **No live X testing was performed for this excerpt** — this sandbox's egress policy blocks arbitrary
  outbound HTTP to `api.x.com`, so this transport has been verified against upstream's own source and
  documented X API v2 behavior only, never exercised against the real endpoint. See
  RISK_REGISTER.md §2L's "Live X testing" entry.
