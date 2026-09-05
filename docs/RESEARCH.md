# RESEARCH.md — X/Twitter Tooling Evaluation for Metrivio Growth Engine

**Date:** 2026-09-04
**Scope:** Evaluate existing open-source X/Twitter tooling before writing any prospecting, outreach, or content code. No LinkedIn tooling was researched or considered — this project is X-only. Apollo was not evaluated or used, per instruction.

---

## 1. Repositories Evaluated

| Repo | Purpose | Stars | License | Last activity |
|---|---|---|---|---|
| **nirholas/XActions** | Full X toolkit: scrapers, MCP server, CLI, browser scripts, dashboard | 428 | Apache-2.0 | Active, ~3 weeks old commits, v3.5.0, 327 commits |
| **tylerbuilds/x-manager** | Self-hosted scheduling/engagement/analytics platform, official X API-based | 16 | MIT | Active, v0.2.0, 25 commits |
| **vladkens/twscrape** | Python async library, multi-account session pool, GraphQL scraping | ~1.6k | MIT (community fork ecosystem) | Active, updated Jun 2026 |
| **elizaOS/agent-twitter-client** (and forks) | Node/TS "no API key" X client used by AI agent frameworks | Varies by fork | MIT | Mixed — canonical repo has moved/forked multiple times, inconsistent maintenance |
| **Houseofmvps/opentechalyzer ("OpenTechAnalyzer")** | Metrivio's primary technology-detection layer | 1–2 (small, new) | MIT | Active, v0.4.2, 11 commits, current as of this research |
| **projectdiscovery/wappalyzergo** | Go port of the last open-source Wappalyzer fingerprint DB, technology detection | Actively maintained by ProjectDiscovery (reputable security tooling org) | MIT | Active |
| Original **AliasIO/Wappalyzer** | Technology detection | N/A | **Went closed-source Aug 2023** — GitHub repo taken down, npm deprecated, fingerprint DB pulled into commercial product | Not usable |

---

## 2. XActions (nirholas/XActions) — Detailed Evaluation

**What it is:** A JS/TypeScript toolkit that reads X data via X's internal GraphQL endpoints (no official API key) and can perform browser-driven write actions (follow, like, post, DM) via Puppeteer. Ships as an npm package, CLI, MCP server (144 tools), browser console scripts, and a Docker image.

**Strengths:**
- Read-side (`x_get_profile`, `x_get_followers`, `x_get_tweets`, `x_search_tweets`, etc.) works without login for public data and without paying X API fees — directly relevant to Parts 3/4/17/18 of the brief (discovery, enrichment, engagement-based prospecting).
- Native **MCP server** with tool-group filtering (`read`, `write`, `dm`, `analytics`, etc.), a **24-hour rolling write budget enforced on disk**, and an **approval-gate mode** (`XACTIONS_MCP_REQUIRE_APPROVAL=1` turns writes into drafts requiring explicit release) — this maps almost exactly onto the brief's "human approval mode" and "kill switch" requirements.
- SQLite-backed session store, per-account rate-limit windows read from X's own response headers, checkpointed pagination (a scrape that dies mid-run resumes from its cursor, not from zero) — directly supports the brief's reliability requirements (Part 21).
- Apache-2.0 license — permissive, commercial use explicitly welcomed by the author.
- Active development (commits within the last month), reasonably thorough docs, a test suite referenced in CONTRIBUTING.md (913 tests as of that doc).

**Risks / limitations:**
- **Small project, single maintainer, modest community**: 428 stars, 9 watchers, 8 open issues, 9 open PRs. Bus-factor risk is real — if the maintainer stops responding to X's endpoint changes, the toolkit can go stale quickly (X rotates GraphQL query IDs regularly; the README itself acknowledges this happens "every 2–4 weeks" industry-wide).
- **The repo's own disclaimer states the scripts "have not been extensively tested on personal accounts"** and use is "at your own risk," with no liability accepted for account restrictions or bans. This is a direct, self-reported reliability caveat we must take seriously, not a boilerplate license disclaimer.
- **Browser-automation write actions (follow, like, DM, auto-comment) sit in a gray-to-black area of X's Terms of Service and Automation Rules.** X explicitly restricts bulk automated engagement and unsolicited automated DMs. Read scraping of public data is lower-risk than automated write actions; XActions' own docs list "Auto follow, like, comment" as headline features, which is the highest-risk part of the toolkit.
- No independent security audit found. The repo does include an `AUDIT_REPORT.md`, but it is self-authored, not third-party.
- Because it's a single fast-moving repo (not a stable package with semantic versioning discipline visible), pinning a specific commit/tag rather than tracking `main` will be necessary for reproducibility.

**Verdict:** Use as the **read/discovery adapter** (profile, search, followers/following, tweet scraping, engagement signals) behind our own adapter interface. **Do not** use its automated write/engagement features (auto-follow, auto-like, auto-comment) — these are the parts of X's rules we're most likely to violate and the parts most likely to get an account suspended. DM sending and posting, if done through XActions at all, must go through its approval-gated draft mode and stay under conservative, configurable daily limits — never on the automation/auto-* code paths.

---

## 2A. OpenTechAnalyzer (Houseofmvps/opentechalyzer) — Verified, Now the Primary Technology-Detection Layer

**Correction to the prior version of this document:** the earlier research pass could not locate this repository and flagged it as an open blocking item. The founder subsequently supplied the exact repository URL — `https://github.com/Houseofmvps/opentechalyzer` — and it has now been directly inspected (README, `package.json`, license file). It is a real, actively-structured, MIT-licensed project that matches the intended role closely. **There is no remaining "OpenTechAnalyzer unresolved" blocker.**

**What it is:** A self-hosted, no-API-key, no-subscription website technology detector, distributed as an npm package (`opentechalyzer`, current version `0.4.2`), exposing a **CLI** (`ota` / `opentechalyzer`), a **TypeScript/JavaScript library** (`import { analyze, analyzeMany } from 'opentechalyzer'`), and an **MCP server** (`opentechalyzer-mcp`, 11 tools) — all from the same codebase. Everything runs locally; there is no hosted service and no API key, with one narrow exception (reverse lookup, §2A.6 below).

**License:** MIT, confirmed directly in the repository's `LICENSE` file and `package.json` (`"license": "MIT"`). The README states explicitly: "Use it commercially, embed it, fork it, resell it. No attribution required." The built-in 588-fingerprint database (`src/fingerprints/`) is stated to be written for this project and MIT-licensed, not copied from another dataset. **One licensing nuance to carry forward:** an optional `opentechalyzer db import` command can pull in a wider, community-maintained fingerprint dataset (`enthec/webappanalyzer`) that is **GPL-3.0**. The project deliberately does not vendor/redistribute that data — it's fetched to the user's own machine on request and stays under its own license — so using it doesn't relicense opentechalyzer itself, but it does mean any Metrivio deployment that runs `db import` is holding GPL-3.0 data locally. See RISK_REGISTER.md for the resulting handling rule.

**Node requirement:** `>=18.17` (from `package.json` `engines`). Package is ESM (`"type": "module"`).

**Package/version information (as inspected):** `opentechalyzer@0.4.2`. Dependencies: `@modelcontextprotocol/sdk`, `kleur`, `zod`. Optional peer dependency: `playwright` (only needed for the `--render` / render-mode capability, not required for base operation).

### 2A.1 CLI

Confirmed via README and `package.json` `bin` entries (`opentechalyzer`, `ota`, `opentechalyzer-mcp`). Supports single-URL scans, bulk scans from a file with configurable concurrency (`-i domains.txt -j 10`), category filtering, multiple output formats (`text`/`json`/`markdown`/`csv`/`summary`), subdomain discovery, email verification, CVE lookup, change tracking (`ota watch`), and reverse lookup (`ota reverse`).

### 2A.2 TypeScript library — confirmed as the integration method to use

The package exports `analyze`, `analyzeMany`, `detect`, `combineConfidence`, `getFingerprints`, `BUILTIN_FINGERPRINTS`, `DATABASE_VERSION`, `listCategories`, `clearFingerprintCache`, `importExternalDatabase`, `loadExternalDatabase`, `externalDatabaseStatus`, `externalDbPath`, `EXTERNAL_DB_LICENSE_NOTICE`, `isRenderAvailable`, `formatTerminal`, `formatMarkdown`, `formatCsv`, `summarise`, plus TypeScript types — directly importable, per the founder's instruction to prefer library integration over CLI shell-out. **This changes a prior architectural assumption:** because both OpenTechAnalyzer and Metrivio's application are TypeScript/Node, `analyze()`/`analyzeMany()` are called as in-process function calls, not as a subprocess. (This is different from wappalyzergo, which is a Go binary and would have needed a subprocess either way — one more reason OpenTechAnalyzer is the better-fitting primary choice for this specific codebase, independent of the founder's naming instruction.)

### 2A.3 `analyze()` — confirmed signature and output shape

```ts
const result = await analyze('https://example.com', {
  render: true,        // optional Playwright render pass — JS-injected tech
  crawl: 5,             // optional: follow up to 5 internal pages (contact/about)
  sourcemaps: true,     // optional: exact npm dependency names/versions from sourcemaps
  fields: ['contact', 'social', 'security', 'signals'], // optional enrichment sets
});
```

Confirmed output shape (from the README's documented JSON structure): `url`, `finalUrl`, `status` (HTTP status of the scan itself), `detections[]` (each with `name`, `categories[]`, `version`, `accountIds[]`, `confidence` 0–100, `inferred` boolean, `evidence[]`), `byCategory`, `enrichment` (contact/social/security/signals/cpes, populated only if requested via `fields`), `crawledPages[]`, `meta`, `warnings[]`, `timings`, `databaseVersion`, `fingerprintCount`, `analyzedAt`.

### 2A.4 `analyzeMany()` / batch analysis — confirmed

Exported directly from the library for programmatic batch calls; the CLI's bulk mode (`-i file -j N`) and the MCP tool `detect_tech_stack_batch` (documented cap: **25 URLs concurrently**) both wrap the same batch capability. Per-URL failures are reported individually rather than aborting the whole batch — the README states this explicitly ("Failures are reported per URL on stderr, so one dead host never aborts a batch of thousands").

### 2A.5 Confidence scoring and evidence trails — confirmed, and well-suited to Metrivio's evidence model

Confidence is **combined probabilistically, not summed**: documented formula `1 − Π(1 − reliability)` across independent signals, with repeated matches from the *same* signal source explicitly damped so ten weak regex hits against one page can't fake ten independent observations. Every detection carries an `evidence[]` array (`source`, `subject`, `match`, `reliability`) — an audit trail down to the exact header, cookie, DOM selector, or dependency that triggered the match, inspectable via `--verbose` in the CLI or directly in the JSON/library output. This maps cleanly onto the evidence-first requirement already governing the rest of this system (DATABASE.md `evidence` table) — no adaptation needed, the tool's own design philosophy matches ours.

### 2A.6 Rendering (Playwright) and crawling — confirmed, both optional

`--render` (library: `{ render: true }`) triggers an optional headless-browser pass via Playwright (peer dependency, not bundled), which the README states "roughly doubles what is found" because tag managers, injected widgets, and framework globals only exist after JavaScript executes. **This is directly relevant to Meta Pixel and GTM detection specifically** — both are commonly injected via a tag-manager script rather than present in raw server-rendered HTML, so render mode should be treated as the default-on setting for Metrivio's enrichment scans, accepting the added Chromium dependency, rather than an optional extra. `--crawl [n]` (default 5) follows internal pages (contact, about) — the README notes contact/social fields "essentially never" appear on the homepage, so crawl should also default to on when the `contact`/`social` enrichment fields are requested.

### 2A.7 Detection output / relevant fingerprints — verified against the README's own category tables, not assumed

Directly confirmed by name in the README's fingerprint category breakdown:
- **Shopify** — confirmed, listed under Platforms (45 fingerprints: "Shopify, WordPress, Wix, Squarespace...").
- **Klaviyo** — confirmed, listed under both Ecommerce apps (55: "...Klaviyo, Gorgias...") and Marketing automation (25: "Klaviyo, HubSpot, Marketo...").
- **Gorgias** — confirmed, listed under Ecommerce apps and again under Support and chat (13: "...Gorgias, Freshchat...").
- **Recharge** — confirmed, listed under Ecommerce apps ("...Recharge, Klaviyo, Gorgias...").
- **Yotpo** — confirmed, listed under Ecommerce apps ("Judge.me, Yotpo, Recharge...").
- **Meta Pixel** — confirmed, listed under Advertising (16: "Meta Pixel, Google Ads, TikTok...").
- **GA4** — confirmed, listed under Analytics (24: "GA4, GTM, Plausible...").
- **GTM** — confirmed, listed in the same Analytics entry as GA4.
- **Shopify Plus** — **not independently confirmed as a distinct fingerprint.** The README lists "Shopify" as a platform and separately mentions "Shopify Oxygen" under Hosting/PaaS, but does not explicitly document a distinct "Shopify Plus" signature separate from base Shopify detection anywhere in the README text. The tool does capture `accountIds` (e.g., specific GTM/GA4 IDs, Klaviyo public keys) which may incidentally help distinguish store tiers in some cases, but this is not a documented, confirmed Shopify Plus detector. **This is flagged honestly rather than assumed** — if Shopify Plus distinction matters to a specific scoring decision, it should be verified directly against the source in `src/fingerprints/` before being relied on, or treated as `INCONCLUSIVE`/absent-tier evidence until then, per the "never claim a fingerprint exists until verified" instruction.

Also relevant to Metrivio though not in the original brief's list: **account ID capture** (e.g., `GTM-M92FB6B`, `G-MFK23BV2BG`, a Klaviyo public key) is confirmed and useful — it turns "GTM is present" into a specific, checkable identifier, which strengthens the evidence tier of a technology detection without changing what the ICP framework does with it.

### 2A.8 Other capabilities — classified per the founder's instruction (CORE / USEFUL / OPTIONAL / NOT_NEEDED)

| Capability | Classification | Reasoning |
|---|---|---|
| Core tech-stack detection (`analyze`/`analyzeMany`) | **CORE** | This is the reason OpenTechAnalyzer is in the architecture at all — Part 6/7 of the brief depend directly on it. |
| Change tracking (`ota watch`) | **CORE** | Produces exactly the kind of dated before/after observation the ICP document's §16 trigger-verification rule requires (a claimed technology or channel change only counts as a trigger with two dated observations) — this is a built-in, ready-made mechanism for that requirement, applied to technology signals specifically. |
| Social handle extraction (`--fields social`, especially the `x` field) | **USEFUL** | An extracted X handle from a prospect's company website is a legitimate, evidence-tagged way to cross-check or discover a company's official X account distinct from a founder's personal account — directly useful for company identification (Part 5). Other socials (Instagram, TikTok, Facebook, Pinterest, YouTube) are incidental and not used for anything in an X-only system. |
| Company info (`--fields company`) | **USEFUL** | `companyName` is sourced from the site's own structured data (schema.org) and the README calls it "trustworthy" — this is close to a primary-source statement and can be tagged at a high evidence tier for company-identification purposes specifically (not for revenue/spend, which have their own, stricter CONFIRMED bar). `inferredCompanyName` is explicitly labeled as a guess and must be capped at `LIKELY`. |
| Contact extraction (`--fields contact`: email, phone, WhatsApp) | **OPTIONAL** | This project remains X-only; no email outreach channel exists or is planned. A captured contact email is retained only as company-identification/verification evidence (e.g., an email domain matching the company's own domain corroborates company identification) — it is never used to build an email outreach channel. |
| Technology spend estimate (`--fields signals` → `technologySpend`) | **OPTIONAL, kept separate from ICP scoring** | This is a floor estimate of *general software* spend (itemized, paid tools visible from outside), not ad spend. It must **not** be treated as, or conflated with, the ICP document's "Paid Acquisition Activity/Intensity" evidence category, which is specifically about Meta/Google ad activity and job postings — mixing the two would violate "no arbitrary ICP changes." It can be surfaced in the dashboard as general context, never as ICP points. |
| Traffic rank (`--fields signals` → `trafficRank`, via Tranco) | **OPTIONAL** | A weak, non-ICP-category corroborating signal for company scale; not one of the ICP document's fixed Revenue-Fit signal categories, so it cannot add scoring points — dashboard context only. |
| Locale (`--fields locale`) | **OPTIONAL** | Supports the now-configurable, unrestricted-by-default geography filter as a data point, not a scoring factor. |
| Metadata (`--fields meta`) | **OPTIONAL** | Minor company-identification corroboration only. |
| Subdomain discovery, CVE lookup, email verification (SMTP) | **NOT_NEEDED** | Security-research-oriented capabilities with no clear role in Metrivio's marketing-efficiency prospecting use case. Not integrated. |
| Reverse lookup (`ota reverse`) | **Evaluated separately — see §2A.9. Recommendation: V2, not V1.** | |

### 2A.9 Reverse lookup — evaluated separately, recommended for V2, not V1

**What it does:** the inverse of a scan — `ota reverse --tech Shopify --tech Klaviyo --rank 100000` finds candidate domains running a given technology combination, by querying HTTP Archive's public dataset via the user's **own** Google Cloud/BigQuery project (`gcloud auth login` required). Confirmed as genuinely free in typical use (Google's 1TB/month free query tier covers a well-filtered query; the tool prints a cost estimate and dry-runs by default with a 200GB ceiling), but it is not free of *operational* dependency — it requires the founder to have a Google Cloud project and authenticate to it, which is a new credential/setup surface distinct from everything else in this system.

**Why V2, not V1, per the founder's request to justify rather than default:**
1. **Coverage/vantage caveats mean its output can never be evidence on its own.** The README states plainly that reverse-lookup results come from HTTP Archive's *own* Wappalyzer fork (not OpenTechAnalyzer's 588 fingerprints), that coverage follows CrUX and "skews to sites with real Chrome traffic," and that "small or new stores may be absent" — this last point is a direct, material concern for Metrivio's actual ICP range ($1M–$10M revenue DTC brands), which plausibly includes exactly the kind of smaller/newer stores CrUX-based coverage is documented to under-represent. Any reverse-lookup hit must be verified with a direct `analyze()` scan before anything is written to the `evidence` table — the README itself recommends exactly this ("chain it into a real scan").
2. **New operational dependency.** A Google Cloud project, its own auth flow, and (rarely, but possibly) real billing exposure is a new piece of infrastructure this project doesn't otherwise need. It's better proven out after the core X-based discovery methods (keyword/founder/pain-intent/account-graph — Part 3 of the original brief) are built, tested, and already producing qualified prospects.
3. **It's additive, not something being withheld.** Reverse lookup is a discovery-source expansion, not a capability removal — deferring it to V2 costs nothing in V1 functionality and lets it be added later as one more input into the same Discover→Enrich→Verify→Score pipeline, exactly like content-engagement-sourced prospects already are.
4. **This directly follows the founder's own instruction** not to make it part of V1 automatically, and to document the placement decision with reasoning rather than silently deciding either way.

### 2A.10 Accuracy — self-reported, worth noting as a limitation

The repository includes a benchmark script (`npm run benchmark`) scoring detection against a small, hand-verified set of sites (10 sites, 27 expected detections in the sample shown in the README, 100% recall, 0 hard false positives). This is a real, runnable, inspectable benchmark — not just a marketing claim — but it is self-reported by the project's own author and the sample size is small. Treat as "a legitimate, transparent accuracy check exists" rather than "independently verified accuracy," and re-run the benchmark ourselves as part of Stage 2 testing (BUILD_PLAN.md) rather than taking the published numbers on faith.

### 2A.11 What it explicitly cannot do (stated directly in its own README — relevant to our evidence model)

- No company firmographics (employee count, revenue) — confirms this tool is **not** a source of Revenue-Fit evidence categories like employee count; those must continue coming from X-side signals (bio, job postings) as already designed.
- Backend frameworks are often invisible unless they leak via a header/cookie/error page.
- Results are vantage-dependent (geo-redirects, device targeting) — the README recommends checking more than one vantage point before trusting a single scan; worth a note in our own scan methodology rather than assuming one scan is definitive.
- Technology spend is explicitly a floor estimate, not a bill — reinforces the OPTIONAL/non-ICP classification above.

---

## 3. X-Manager (tylerbuilds/x-manager) — Detailed Evaluation


**What it is:** A self-hosted Next.js 15 + SQLite application for scheduling, publishing, and analyzing X content, built around the **official X API** (OAuth 1.0a, pay-per-use credits) rather than scraping. Includes a content calendar, CSV bulk import, thread support, an engagement inbox, an automation-rule engine, RSS-to-post automation, a media library, a URL shortener with UTM tracking, a draft manager with an approval workflow, and a "Bridge API" that lets external bots (like an AI agent) publish through it with token/HMAC auth and rate limiting.

**Strengths:**
- Because it uses the **official X API for write actions** (posting, scheduling), it is the ToS-compliant way to publish and schedule content — this is the right foundation for Part 11/14/15/16 of the brief (content engine, human approval, scheduler, analytics).
- Already implements almost the entire default content workflow the brief specifies: **draft → approval request → approve/reject → schedule → publish**, plus post-level analytics (impressions, likes, retweets, replies, quotes, bookmarks), best-posting-time analysis, and CSV export — this is a very close match to Parts 14–16 without us writing that subsystem from scratch.
- MIT license, no encumbrances.
- Credentials encrypted at rest (AES-256-GCM), HMAC-signed sessions, SSRF protection on webhook/media fetches, and the app **refuses to boot in production without encryption configured** — meets the brief's security requirements (Part 22) out of the box.
- SQLite + Drizzle ORM, zero external services (no Redis/Postgres needed), runs comfortably on a small VPS — operationally simple, matches "favor reliability over unnecessary complexity."
- Real-time event stream (SSE) and a documented agent manifest at `/api/system/agent`, designed explicitly for AI-agent integration.

**Risks / limitations:**
- Small project (16 stars, 3 forks, single maintainer, 25 commits) — younger and less battle-tested than XActions, though its scope (scheduling/publishing) is narrower and lower-risk than scraping.
- **Costs real money**: because it uses the official X API, every scheduled post, read, and lookup is billed on X's pay-per-use credit system (~$0.005–$0.01/action as of the source material). This is a budget line the founder needs to be aware of and cap via X-Manager's built-in usage dashboard and caching.
- Multi-account support is capped at 3 slots — sufficient for Metrivio's single-brand use case, but a known ceiling.
- "Agent Campaigns" (autonomous planning/execution) is explicitly marked **experimental** in the project's own docs — we should not build on that specific module without hardening it ourselves, but the core scheduler/inbox/analytics/Bridge-API surface is stable enough to build on.
- Its **Topic Discovery** feature is a light keyword search, not an ICP-scoring engine — it does not replace the custom prospecting/scoring system this brief requires; it is only useful as a secondary signal source for content ideation.

**Verdict:** Use as the **publishing, scheduling, approval-workflow, and analytics backbone for the content engine** (Parts 11, 14, 15, 16), extended with Metrivio-specific content pillars, research, and drafting logic that calls Claude. Do **not** use it for prospecting/outreach — that is out of its scope and requires the custom ICP engine this brief defines.

---

## 4. Other Options Considered and Rejected (or Deferred)

- **twscrape (vladkens/twscrape)** — Mature, actively maintained Python library with multi-account session rotation and proxy support, MIT-licensed, ~1.6k stars. Strong alternative/fallback for read-side scraping, particularly full-text search and account pooling at higher volume than XActions' single-session model supports. **Decision: documented as the fallback/secondary read adapter**, not the primary, to avoid mixing Python and Node/TS runtimes in the core app unless XActions' read reliability proves insufficient in practice. Because our core app is Node/TS (to share code with the X-Manager-based content engine), adding a Python service is added operational complexity we only take on if needed.
- **elizaOS/agent-twitter-client and its many forks** — Widely used inside AI-agent frameworks (Eliza), but the canonical repository has moved multiple times (`elizaos-plugins/client-twitter` → `plugin-twitter`; a separate, differently-maintained `agent-twitter-client` exists under other GitHub orgs/forks). This fragmentation is itself a reliability red flag — it's unclear which fork is authoritative at any given time. **Decision: not used.** XActions covers the same "no official API key" scraping use case with a single canonical, better-documented repo and an MCP server already built for AI-agent use.
- **snscrape** — Historically the standard free scraper; effectively broken against current X anti-scraping measures per multiple 2026 sources, no longer reliably maintained for X specifically. **Not used.**
- **Nitter-based scrapers** — Nitter instances are largely dead/unreliable as of 2026 due to X's restrictions on the underlying mechanism they depended on. **Not used.**
- **Original Wappalyzer (AliasIO/Wappalyzer)** — Went closed-source in August 2023; GitHub repo and npm package no longer available/maintained as open source. **Not used.**
- **projectdiscovery/wappalyzergo** — Actively maintained, MIT-licensed Go port of the last open fingerprint database, backed by ProjectDiscovery (a known, reputable security-tooling organization with many widely-used projects). **Decision: this is the "OpenTechAnalyzer" implementation** referenced in Part 6 of the brief — run as a small Go CLI/binary wrapped by a Node adapter, or via one of its actively maintained Node/Python CLI wrappers (e.g., `wappy`, built on the same fingerprint database) if a pure-Go subprocess proves awkward to operate.
- **Official X API alone (no scraping at all)** — Considered and rejected as the *sole* data source for prospecting because full-text keyword/pain-signal search and broad account discovery at the volume this brief requires (Parts 3, 17, 18) would be cost-prohibitive and rate-limited under X's current pay-per-use pricing for a five-founding-client-stage business. The official API remains the right choice for **write actions** (posting, scheduling) via X-Manager, where volume is naturally low (a content calendar, not a scraping firehose).

---

## 5. Final Recommendation

**Split the system along a read/write line, not a "one tool for everything" line:**

1. **Read/discovery side (prospecting, enrichment, engagement monitoring, content research):** XActions (primary), with twscrape documented as a fallback adapter if XActions' read reliability degrades in practice. Both sit behind our own `XReadAdapter` interface so either can be swapped without touching business logic.
2. **Write side (posting, scheduling, replying, DMs):** Two implementations sit behind one `XWriteAdapter` interface, selectable by config: **X-Manager** (official X API, OAuth 1.0a) for posting/scheduling/replying, and **XActions' session-based write path** for direct messaging, since official-API DM access typically requires an elevated X API tier unlikely to be available at Metrivio's founding-client stage. Outreach automation (including DM sending) is a first-class, fully supported capability of this system — it is not disabled or removed. What's configurable, per the founder's explicit instruction, is the *mode* it runs in (`dry_run` / `approval_required` / `autonomous`), daily/action limits, and a kill switch — all detailed in ARCHITECTURE.md §7 and RISK_REGISTER.md.
3. **Technology detection:** **OpenTechAnalyzer** (`Houseofmvps/opentechalyzer`, MIT, verified — §2A) is the primary implementation behind `TechAnalyzerAdapter`, integrated as a **direct TypeScript library dependency** (`analyze`/`analyzeMany`), not a CLI shell-out. `wappalyzergo` remains documented as a fallback implementation only — kept in reserve given OpenTechAnalyzer is itself a small, new project (1–2 stars), not because of any doubt about OpenTechAnalyzer's capability or license. Whichever implementation runs, it always returns a status of `DETECTED / NOT_DETECTED / BLOCKED / ERROR / INCONCLUSIVE` — never silently converting a failed scan into `NOT_DETECTED`.
4. **ICP scoring, prospect database, evidence tracking, content research/drafting:** custom-built (no existing open-source project does deterministic ICP scoring or Metrivio-specific content generation) — this is genuinely new work, detailed in `ARCHITECTURE.md` and `DATABASE.md`.

This satisfies the instruction to prefer mature, reusable open-source components rather than unnecessarily rebuilding X functionality, while keeping every fragile or ToS-sensitive integration point isolated behind an adapter so it can be replaced without a rewrite (Part 23 of the brief).

Full risk detail (including the platform-policy risk of automated engagement/DMs) is in `RISK_REGISTER.md`.
