# Vendored: nirholas/xactions (read-only HTTP scraper subtree only)

**Vendored per BUILD_PLAN.md Stage 2 / this repository's Stage 4A instructions**, following the same
vendoring discipline already used for `packages/content/vendor/x-manager` (plain source
snapshot at a pinned commit, `.git` history not included).

- **Source:** https://github.com/nirholas/xactions
- **Pinned commit:** `52fbf89991668d58f7a9e7abbed4441734f87c01` (2026-09-03)
- **Pinned version (package.json):** `3.5.0`
- **Vendored on:** 2026-09-05
- **License:** Apache-2.0 (see `LICENSE` in this directory — unmodified from upstream).
- **Verified directly against the live repository this session** (not assumed from RESEARCH.md alone):
  cloned at the commit above, confirmed via `git ls-remote` that upstream `main`/`HEAD` had not moved
  past this commit before vendoring, and loaded the vendored tree with plain Node to confirm every
  import resolves and every needed export exists (no network call — module loading only).

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

## Files vendored (exact list, all read-only, no write/mutation code)

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
src/scrapers/twitter/http/x-endpoints.generated.js — generated GraphQL query-ID/feature table (see THIRD-PARTY-NOTICES.md)
src/scrapers/twitter/http/parse/user.js   — parseUserData (pure function, profile normalization)
src/scrapers/twitter/http/parse/tweet.js  — parseTweetData (pure function, tweet normalization)
src/client/auth/userAgents.generated.js   — generated User-Agent pool (see THIRD-PARTY-NOTICES.md)
```

Original relative directory structure (`src/scrapers/twitter/http/...`, `src/client/auth/...`) is
preserved exactly so every import statement inside these files is byte-identical to upstream — no
import paths were rewritten. This keeps re-syncing against a newer upstream commit a simple diff rather
than a re-port.

**Deliberately NOT vendored:** `actions.js`, `engagement.js`, `dm.js`, `media.js` (all write/mutation
paths — posting, liking, following, DMing), `communities.js`, `notifications.js`, `explore.js`
(discovery-adjacent but out of Stage 4A's scope), `accountPool.js` (multi-account rotation — not needed
for single guest-token/single-cookie usage, and pulls in `better-sqlite3` for a capability this stage
doesn't use), `auth.js` / `playwright-session.js` (full auth-flow and Playwright-session-harvesting —
`TwitterHttpClient` itself already accepts a cookie string directly via its constructor, so neither is
needed for Stage 4A's guest-mode-default / cookie-mode-if-configured design), the entire Puppeteer
application layer, Express API server, Prisma schema, Stripe/x402 payment layer, Redis, the MCP server,
the CLI, the dashboard, and every non-Twitter platform scraper.

## Hand-authored TypeScript declarations (NOT part of the upstream snapshot)

`client.d.ts`, `errors.d.ts`, `profile.d.ts`, and `search.d.ts` alongside their respective `.js` files
in this directory were written by us, not copied from upstream (upstream ships plain JS with JSDoc, no
`.d.ts` files). They declare only the narrow surface `packages/adapters/src/xactions-read.adapter.ts`
actually consumes, so TypeScript can type-check the adapter without needing `allowJs`/`checkJs` across
this entire vendored tree (which would type-check foreign code we don't intend to modify or fix).
**If the pin is ever bumped, these four files must be manually reviewed against the new upstream JSDoc
shapes** — they are not auto-verified against upstream and are the one part of this directory that is
genuinely ours.

## Update procedure

1. Re-clone `nirholas/xactions` at the desired newer commit.
2. Diff its `src/scrapers/twitter/http/` (and `src/client/auth/userAgents.generated.js`) against this
   directory's corresponding files.
3. Re-run the "load with plain Node" sanity check (see above) against the new files before replacing.
4. Update the pinned commit/version at the top of this file.
5. Manually review the four hand-authored `.d.ts` files against any upstream JSDoc changes.
6. Re-run `packages/adapters/test/xactions-read.adapter.test.ts` (all fixtures are based on real
   observed response shapes, not live calls, so they will catch a shape change here).

## Known upstream risk considerations (see also RISK_REGISTER.md)

- **Single-maintainer, fast-moving project** (RESEARCH.md §2) scraping X's undocumented, internal
  GraphQL API — X rotates query IDs periodically, and upstream's own `queryIds.js` includes runtime
  auto-discovery specifically to cope with that. Pinning a commit trades staying current for
  reproducibility; the query-ID auto-refresh mechanism (`autoRefreshQueryIds`, on by default outside
  `VITEST`) means some drift-tolerance survives the pin, but a large X-side API change could still break
  this vendored snapshot before the pin is bumped.
- **Upstream's own disclaimer applies unchanged:** "educational and research purposes only... has not
  been extensively tested on personal accounts... use at your own risk... we are not responsible for
  any account restrictions or bans." This vendored subtree is read-only, which upstream's own docs
  describe as the lower-risk half of the toolkit compared to its write/engagement automation — but the
  disclaimer is not scoped only to writes, and is carried forward here without softening it.
- **Guest-token behavior verified from source, not from a live call** (this sandbox's egress policy
  blocks arbitrary outbound HTTP, so no live X request was made or could be made this session): reading
  `client.js`'s constructor and upstream's own `createHttpScraper()` convenience factory, a bare
  `TwitterHttpClient` with no `cookies` option appears to be upstream's own intended "guest mode" usage
  (its factory does not perform any separate guest-token acquisition step when no cookie is supplied).
  This is stated as a source-verified but **not live-verified** fact — do not treat it as confirmed
  working behavior until exercised against real X endpoints.
