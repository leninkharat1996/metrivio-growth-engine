# Vendored: nirholas/xactions (HTTP scraper subtree — read-only, plus one narrow send operation)

**Vendored per BUILD_PLAN.md Stage 2 / this repository's Stage 4A instructions**, following the same
vendoring discipline already used for `packages/content/vendor/x-manager` (plain source
snapshot at a pinned commit, `.git` history not included). Extended in **Stage 6B-R** to add one
write operation (`dm.js`'s `sendDM`, trimmed — see below) once its request format was verified
against upstream's own source and test suite, resolving the blocker Stage 6B correctly stopped at.

- **Source:** https://github.com/nirholas/xactions
- **Pinned commit:** `52fbf89991668d58f7a9e7abbed4441734f87c01` (2026-09-03)
- **Pinned version (package.json):** `3.5.0`
- **Vendored on:** 2026-09-05 (read-only subtree); **extended** 2026-09-06 (Stage 6B-R: `dm.js` excerpt)
- **License:** Apache-2.0 (see `LICENSE` in this directory — unmodified from upstream).
- **Verified directly against the live repository this session** (not assumed from RESEARCH.md alone):
  cloned at the commit above, confirmed via `git ls-remote` that upstream `main`/`HEAD` had not moved
  past this commit before vendoring, and loaded the vendored tree with plain Node to confirm every
  import resolves and every needed export exists (no network call — module loading only).
- **Stage 6B-R re-verification:** re-cloned the same pinned commit specifically to inspect
  `src/scrapers/twitter/http/dm.js` (previously deliberately excluded — see Stage 4A's original
  exclusion list, now superseded below) and its own test file
  `tests/http-scraper/dm.test.js`. Confirmed `package.json` version (`3.5.0`) and `LICENSE` are
  byte-identical to the already-vendored copies, i.e. genuinely the same commit, not a different
  revision.

## Why only these files

Upstream `nirholas/xactions` is a large, multi-purpose monorepo: a full Express/Prisma/Stripe/Redis
backend, an MCP server, a dashboard, browser-automation (Puppeteer + stealth plugin) write/engagement
features, and scrapers for several other platforms (Bluesky, Mastodon, Threads). Its root `package.json`
declares 30 npm dependencies. **Installing the `xactions` npm package as a normal dependency would pull
in that entire tree regardless of which subpath is imported** (npm installs are not tree-shaken), which
is a large, unrelated dependency/attack-surface cost for a system that only needs three read-only
functions.

Directly inspecting the source, the **read-only HTTP scraper module
(`src/scrapers/twitter/http/*`) is self-contained with zero third-party npm dependencies** beyond Node
built-ins (`fs`, `path`, `crypto`) — it does not touch Puppeteer, Prisma, Stripe, Redis, or Express at
all. This made vendoring a minimal subtree of just that module both possible and clearly the right
choice over a full npm install, a CLI subprocess, or an MCP-server integration (see
`docs/RESEARCH.md` §2 / the Stage 4 planning report in this repository's history for the full
integration-method comparison).

## Files vendored (exact list)

```
src/scrapers/twitter/http/client.js       — TwitterHttpClient (HTTP core, auth headers, retry, rate-limit detection)
src/scrapers/twitter/http/errors.js       — TwitterApiError / RateLimitError / AuthError / NotFoundError / NetworkError
src/scrapers/twitter/http/endpoints.js    — GraphQL/REST endpoint map, bearer token, feature switches
src/scrapers/twitter/http/queryIds.js     — runtime query-ID discovery/cache (reads $XACTIONS_HOME or ~/.xactions)
src/scrapers/twitter/http/transactionId.js — x-client-transaction-id request signing
src/scrapers/twitter/http/guest.js        — guest-token support helpers (browserNavigationHeaders used by queryIds/transactionId)
src/scrapers/twitter/http/checkpoint.js   — resumable-scrape checkpoint file helper (used by search.js/tweets.js)
src/scrapers/twitter/http/profile.js      — scrapeProfile / scrapeProfileById
src/scrapers/twitter/http/search.js       — searchTweets / searchUsers
src/scrapers/twitter/http/tweets.js       — scrapeTweets (transitively required by search.js for tweet parsing)
src/scrapers/twitter/http/dm.js           — sendDM ONLY (Stage 6B-R, TRIMMED EXCERPT — see below, not a whole-file vendor)
src/scrapers/twitter/http/x-endpoints.generated.js — generated GraphQL query-ID/feature table (see THIRD-PARTY-NOTICES.md)
src/scrapers/twitter/http/parse/user.js   — parseUserData (pure function, profile normalization)
src/scrapers/twitter/http/parse/tweet.js  — parseTweetData (pure function, tweet normalization)
src/client/auth/userAgents.generated.js   — generated User-Agent pool (see THIRD-PARTY-NOTICES.md)
```

Original relative directory structure (`src/scrapers/twitter/http/...`, `src/client/auth/...`) is
preserved exactly so every import statement inside these files is byte-identical to upstream — no
import paths were rewritten. This keeps re-syncing against a newer upstream commit a simple diff rather
than a re-port. **`dm.js` is the one exception to "byte-identical whole file"** — see the dedicated
section below.

**Deliberately NOT vendored:** `actions.js`, `engagement.js`, `media.js` (write/mutation paths —
posting, liking, following), `communities.js`, `notifications.js`, `explore.js` (discovery-adjacent
but out of Stage 4A's scope), `accountPool.js` (multi-account rotation — not needed for single
guest-token/single-cookie usage, and pulls in `better-sqlite3` for a capability this stage doesn't
use), `auth.js` / `playwright-session.js` (full auth-flow and Playwright-session-harvesting —
`TwitterHttpClient` itself already accepts a cookie string directly via its constructor, so neither is
needed for Stage 4A's guest-mode-default / cookie-mode-if-configured design), the entire Puppeteer
application layer, Express API server, Prisma schema, Stripe/x402 payment layer, Redis, the MCP server,
the CLI, the dashboard, and every non-Twitter platform scraper.

## `dm.js` — trimmed excerpt, not a whole-file vendor (Stage 6B-R)

Stage 4A originally excluded `dm.js` entirely (write/mutation path, out of that stage's read-only
scope). Stage 6B needed exactly one DM-send operation and correctly refused to invent its request
format rather than guess. Stage 6B-R re-cloned upstream at the **same already-pinned commit** and
inspected `dm.js` directly, together with its own test file `tests/http-scraper/dm.test.js`
(`describe('sendDM()', ...)`, which asserts the exact request URL and body shape below against a
mocked client — never a live call, upstream's or ours).

**What was verified, and against what:**
- **Request URL/method:** `POST ${REST_BASE}${REST.dmNew}` (`REST.dmNew` already vendored, unchanged,
  `/1.1/dm/new2.json`) — verified against `dm.js`'s own `sendDM()` body and against
  `dm.test.js`'s assertion `expect(url).toContain('/1.1/dm/new2.json')`.
- **Request body shape:** `{ event: { type: 'message_create', message_create: { target: { recipient_id }, message_data: { text } } } }` —
  verified against `dm.test.js`'s exact `expect(body).toEqual({...})` assertion (upstream's own
  JSDoc comment names the older, differently-shaped `/1.1/direct_messages/events/new.json` path in a
  stale comment; the code and the endpoint actually used is `dm/new2.json` — code and test, not the
  comment, are the source of truth here).
- **Authentication:** `requireAuth(client)` throws `AuthError` when `!client.isAuthenticated()` —
  identical concept to, and reuses, the same `isAuthenticated()`/cookie/CSRF-header machinery already
  vendored in `client.js` and already used by the read-only adapter; no new auth mechanism.
- **Target identity:** `recipientId` is X's own numeric user ID, passed straight through as
  `String(recipientId)` with no username fallback — matches Stage 6B's own `XSendAdapter.
  sendDirectMessage({targetUserId, ...})` contract exactly, with no adapter-level translation needed.
- **Response shape:** `response.event.id` / `response.event.created_timestamp`, mapped in `sendDM()`
  itself to `{messageId, createdAt}` — verified against `dm.test.js`'s `MOCK_DM_EVENT` fixture and
  assertions on `result.messageId`/`result.createdAt`.
- **Error behavior:** goes through the already-vendored `client.request()` (unchanged), which already
  maps HTTP 401/403 → `AuthError`, 404 → `NotFoundError`, 429 → `RateLimitError`, and network failures
  → `NetworkError` — no new error-handling path for this one operation; `sendDM()` itself only adds
  two pre-flight `TwitterApiError`s for a missing `recipientId` or empty `text`.
- **Licensing:** identical Apache-2.0 header, same commit, same repository already accepted for the
  rest of this subtree — no new license terms.

**Only `sendDM` (plus its two private helpers `requireAuth` and `buildDMBody`) was vendored — not the
whole file**, per Stage 6B-R's explicit "implement only the minimal transport necessary, do not expand
scope" instruction. Everything else `dm.js` exports was deliberately left out, and is NOT reachable
from any Metrivio code:
- `sendDMByUsername` / `resolveUserId` — username-based targeting, which Stage 6B's own contract
  rejects in favor of a canonical user ID.
- `getInbox` / `getConversation` (+ their parsing helpers) — DM/conversation *reading*, i.e. reply
  detection, explicitly deferred to a future stage by both Stage 6A and Stage 6B.
- `deleteMessage` — a second, distinct write capability (deleting a sent DM) with no corresponding
  contract anywhere in this codebase.
- `markRead` — read-receipt state, unrelated to sending.

The vendored `dm.js` in this directory is a byte-identical copy of the three retained functions (only
the `import { GRAPHQL, ... }` line was narrowed to `import { REST, REST_BASE }`, since the omitted
functions were the only consumers of `GRAPHQL`) — see the file's own header comment for the same
provenance note in-line. Because this is a hand-trimmed excerpt rather than a whole-file copy, a
future pin bump requires a manual line-by-line diff of `sendDM`/`buildDMBody`/`requireAuth` against
the new upstream `dm.js`, not a straight file replacement — called out explicitly in the update
procedure below.

## Hand-authored TypeScript declarations (NOT part of the upstream snapshot)

`client.d.ts`, `errors.d.ts`, `profile.d.ts`, `search.d.ts`, and (Stage 6B-R) `dm.d.ts` alongside
their respective `.js` files in this directory were written by us, not copied from upstream (upstream
ships plain JS with JSDoc, no `.d.ts` files). They declare only the narrow surface
`packages/adapters/src/xactions-read.adapter.ts` / `xactions-send.adapter.ts` actually consume, so
TypeScript can type-check the adapters without needing `allowJs`/`checkJs` across this entire vendored
tree (which would type-check foreign code we don't intend to modify or fix).
**If the pin is ever bumped, these five files must be manually reviewed against the new upstream JSDoc
shapes** — they are not auto-verified against upstream and are the one part of this directory that is
genuinely ours.

## Update procedure

1. Re-clone `nirholas/xactions` at the desired newer commit.
2. Diff its `src/scrapers/twitter/http/` (and `src/client/auth/userAgents.generated.js`) against this
   directory's corresponding files. **`dm.js` is hand-trimmed, not a whole-file copy** — diff the new
   upstream `dm.js`'s `sendDM`/`buildDMBody`/`requireAuth` specifically against this directory's
   `dm.js`, and re-verify the request URL/body/response assertions in the new upstream
   `tests/http-scraper/dm.test.js` still match before updating.
3. Re-run the "load with plain Node" sanity check (see above) against the new files before replacing.
4. Update the pinned commit/version at the top of this file.
5. Manually review the five hand-authored `.d.ts` files against any upstream JSDoc changes.
6. Re-run `packages/adapters/test/xactions-read.adapter.test.ts` and
   `packages/adapters/test/xactions-send.adapter.test.ts` (all fixtures are based on real observed
   response shapes and upstream's own test assertions, not live calls, so they will catch a shape
   change here).

## Known upstream risk considerations (see also RISK_REGISTER.md)

- **Single-maintainer, fast-moving project** (RESEARCH.md §2) scraping X's undocumented, internal
  GraphQL API — X rotates query IDs periodically, and upstream's own `queryIds.js` includes runtime
  auto-discovery specifically to cope with that. Pinning a commit trades staying current for
  reproducibility; the query-ID auto-refresh mechanism (`autoRefreshQueryIds`, on by default outside
  `VITEST`) means some drift-tolerance survives the pin, but a large X-side API change could still break
  this vendored snapshot before the pin is bumped.
- **Upstream's own disclaimer applies unchanged:** "educational and research purposes only... has not
  been extensively tested on personal accounts... use at your own risk... we are not responsible for
  any account restrictions or bans." This vendored subtree was originally read-only, which upstream's
  own docs describe as the lower-risk half of the toolkit compared to its write/engagement automation
  — Stage 6B-R adds exactly one narrow write operation (`sendDM`) to that otherwise read-only subtree,
  so this disclaimer now applies with correspondingly more weight than before, not less; it is carried
  forward here without softening it either way.
- **Guest-token behavior verified from source, not from a live call** (this sandbox's egress policy
  blocks arbitrary outbound HTTP, so no live X request was made or could be made this session): reading
  `client.js`'s constructor and upstream's own `createHttpScraper()` convenience factory, a bare
  `TwitterHttpClient` with no `cookies` option appears to be upstream's own intended "guest mode" usage
  (its factory does not perform any separate guest-token acquisition step when no cookie is supplied).
  This is stated as a source-verified but **not live-verified** fact — do not treat it as confirmed
  working behavior until exercised against real X endpoints.
