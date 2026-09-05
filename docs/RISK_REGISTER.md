# RISK_REGISTER.md — Metrivio X Growth Engine

Each risk is rated Likelihood (L/M/H) × Impact (L/M/H), with a mitigation and an owner-decision note where the founder needs to make an explicit call rather than have one made silently in code.

---

## 1. Platform Policy Risk — Automated Outreach & Engagement

**Risk:** X's Terms of Service and Automation Rules restrict bulk automated engagement (mass follow/unfollow, automated liking at scale, unsolicited automated DM campaigns) and platform manipulation more broadly. A cold-outreach system that DMs discovered prospects — even a well-targeted one — sits inside the category of automated messaging X's rules are written to constrain, and this risk scales with volume and pattern.

**Decision on record:** the founder has explicitly decided that automated X prospecting and automated X outreach, including DM sending, are wanted capabilities of this system and should not be removed or architecturally restrained because of this risk. This document is no longer proposing that the system avoid or minimize outreach automation — it is documenting the risk honestly so the operating controls below are used deliberately, not as a reason to withhold the feature.

**Likelihood:** Medium-High if volume/pattern is aggressive and undifferentiated; Low-Medium if targeted, evidence-based, and paced conservatively — the architecture is built to make the latter the easy default without blocking the former if the founder chooses it.
**Impact:** High — account suspension would take down both the outreach channel and the content/publishing channel if they share an account. This impact rating is exactly why the controls below exist as real, working mechanisms rather than cosmetic settings.

**Controls built into the architecture (all configurable, all real, none of them a substitute for the founder's own risk-tolerance judgment):**
- `automation_mode` (`dry_run` / `approval_required` / `autonomous`), independently settable for outreach, with `autonomous` fully implemented and tested as a supported end state (ARCHITECTURE.md §7).
- Per-action-type daily/action limits (DMs, follows, scrapes), persisted across restarts, editable in Settings.
- A Session Health Monitor (ARCHITECTURE.md §3.5) that watches error rate, auth failures, and rate-limit headroom on the connected account and can automatically pace down or drop to `approval_required` if the account shows signs of strain — itself a configurable behavior (`session_health_auto_downgrade`), so even this safety net is the founder's choice, not a hardcoded ceiling.
- A global kill switch that overrides every other setting instantly.
- Evidence-gated personalization, which naturally differentiates this system's outreach from spam/bulk-blast patterns, since a message cannot be generated without a real, sourced reason for contacting that specific person.
- Full audit logging of every send, every mode change, and every health-state transition, so account behavior is reviewable after the fact regardless of which mode was active.
- Bulk mass-follow/unfollow, auto-like farming, and auto-commenting (as distinct from targeted, evidence-based DM/reply outreach) remain out of scope — not because outreach automation is restrained, but because those specific mechanics are a different capability (visibility/growth gaming) than what this system is built to do, and they are the parts of X's rules most clearly and unambiguously written against, with the least defensible "this is targeted communication, not spam" argument available.

**Owner decision needed:** volume/pacing (how many DMs/day, from which account, how aggressively to ramp) is a business risk-tolerance call the founder makes through Settings, not something the code decides. The system supports any point on that spectrum, including fully autonomous, high-volume operation if that's the founder's choice — the recommendation to start conservative and watch the Session Health signal before increasing is a suggestion, not an enforced constraint.

---

## 2. Platform Policy Risk — Scraping (Read Side)

**Risk:** Reading public profile/tweet/search data via unofficial GraphQL access (XActions) is lower-risk than automated writes but still not X's officially sanctioned access path, and X periodically changes endpoints specifically to break unofficial scraping.

**Likelihood:** Medium (endpoint changes are described industry-wide as happening every 2–4 weeks).
**Impact:** Medium — breaks discovery/enrichment until the adapter is updated or swapped; does not directly risk account suspension for read-only, unauthenticated public data access, but does risk suspension if scraping is done from a *logged-in* session at high volume/velocity.

**Mitigations:**
- `XReadAdapter` isolation means an endpoint break is a contained, fixable failure, not a system-wide outage.
- Rate limits and human-like pacing on any logged-in scraping (followers/following require login per XActions' own docs).
- Fallback adapter (twscrape) documented as a second implementation path if XActions read reliability degrades.
- Discovery/enrichment jobs log zero-result runs distinctly from "job didn't run," so an endpoint break is visible quickly rather than silently returning empty data that looks like "no prospects found."

---

## 2A. Stage 4A Implementation Findings — Kill-Switch Scope, Vendoring, and a Verified-Not-Live-Tested Behavior

**Kill-switch scope extended to X reads (policy decision, not a redesign).** ARCHITECTURE.md §7 documents the kill switch as covering "every write-adapter call." Stage 4A implements the founder-approved policy that it should also cover `XReadAdapter` reads, since bulk reads carry real account-restriction risk per XActions' own disclaimer (§2 above), not just writes. This was done as the smallest possible call-site change — `XActionsReadAdapter.getProfile`/`searchTweets` each call the existing, unmodified `KillSwitch.assertNotActive()` before any network call — not a change to `KillSwitch`'s own implementation. Future write-adapter implementations already do (or will do) the same; this just extends the same check to the read side for this one adapter.

**Vendoring dependency-footprint finding (confirmed, not assumed).** Direct source inspection of `nirholas/xactions` at the pinned commit found that its read-only HTTP scraper module (`src/scrapers/twitter/http/*`) has **zero third-party npm dependencies** beyond Node built-ins — it does not touch any of the root package's 30 dependencies (Puppeteer, Prisma, Stripe, Redis, Express, JWT/bcrypt, etc.). Vendoring only that subtree (`packages/adapters/vendor/xactions-http/`, see its own `VENDOR.md`) means Stage 4A added **zero new npm packages** to this repository's dependency tree — verified via `npm install` reporting the same package count before and after, and via `package-lock.json` showing no diff.

**Contract gap, documented rather than silently resolved:** the existing `XReadAdapter` interface has no `getProfileById`-equivalent method, even though the underlying XActions library supports profile lookup by numeric user ID (`scrapeProfileById`) as well as by handle. Stage 4A does not add one — extending the interface was out of scope ("do not unnecessarily modify the core adapter interface"). If a later stage needs ID-based lookup (e.g. re-resolving a prospect whose handle changed, using the already-stored `x_user_id`), this is the exact, minimal interface addition that would be needed — flagged here rather than added speculatively.

**Additive design applied, documented per instruction:** `XReadAdapter`'s existing methods return bare result types with no status/error model, unlike Stage 2's `TechAnalyzerResult.scanStatus`. Rather than widening those return types (an interface change), Stage 4A added five generic, adapter-agnostic error classes (`XReadRateLimitedError`, `XReadAuthenticationRequiredError`, `XReadNotFoundError`, `XReadNetworkError`, `XReadUnexpectedError`) to `packages/core/src/adapters/x-read-adapter.ts`, thrown instead of ever collapsing a real failure into an empty successful result — mirroring the existing `KillSwitchActiveError`/`NotImplementedInStage1Error` pattern already used elsewhere in this codebase. This is additive only; `XReadAdapter`, `ProfileResult`, `TweetResult`, `AccountResult`, and `XReadOptions` are all unchanged.

**Verified from source, not from a live call — flagged explicitly, not claimed as confirmed working.** This sandbox's egress policy blocks arbitrary outbound HTTP (confirmed directly in earlier stages of this project), so no live X request was made or could be made. Reading `TwitterHttpClient`'s constructor and XActions' own `createHttpScraper()` convenience factory, a bare client with no cookie supplied appears to be upstream's own intended "guest mode" (no separate guest-token acquisition step is performed for the no-cookie case in that factory). This is stated as source-verified, not live-verified — the first real integration test against live X data should specifically confirm guest-mode reads actually succeed before this is relied upon in a discovery pipeline.

---

## 3. Single-Maintainer / Small-Project Dependency Risk

**Risk:** XActions (428 stars, 1 primary maintainer), X-Manager (16 stars, 1 primary maintainer), and now **OpenTechAnalyzer** (Houseofmvps/opentechalyzer, 1–2 stars, very new — RESEARCH.md §2A) are all small projects. If any goes unmaintained, we inherit their maintenance burden or must migrate. This is somewhat elevated for XActions specifically since its write path is architecturally load-bearing (it's the DM-sending implementation, not just a read-side fallback), and OpenTechAnalyzer is the smallest, newest project of the three despite now being the confirmed, verified, primary technology-detection dependency.

**Likelihood:** Medium over a multi-month horizon.
**Impact:** Medium — contained by the adapter pattern (§6 of ARCHITECTURE.md); a maintenance stall means forking/patching a pinned version ourselves, not a rewrite. Since DM sending depends on XActions specifically and all technology evidence depends on OpenTechAnalyzer specifically, both are worth a closer watch than a purely secondary/fallback dependency would warrant.

**Mitigations:**
- Pin exact versions/commits, never track `main`, for all three.
- Vendor (fork) X-Manager specifically, since it's the write-path backbone — control exactly when upstream changes land.
- **This is the concrete, legitimate reason wappalyzergo remains documented as a fallback `TechAnalyzerAdapter` implementation**, per the founder's own instruction that wappalyzergo may stay "if your research shows a legitimate reason to keep it": OpenTechAnalyzer's small size and short commit history is exactly that reason. It is not a reflection of any doubt about OpenTechAnalyzer's license, capability, or the decision to make it primary — it's ordinary dependency risk hygiene applied evenly, the same reasoning already applied to XActions and X-Manager.
- Since the entire built-in OpenTechAnalyzer fingerprint database is itself MIT-licensed and stated in its own README to be "written for this project" (not copied from elsewhere), forking it ourselves if upstream maintenance stalls is straightforward and unencumbered — lower fork risk than a project built on top of someone else's restrictively-licensed data would carry.

---

## 3A. Licensing Boundary — Optional GPL-3.0 External Fingerprint Database

**Risk:** OpenTechAnalyzer's core, built-in 588-fingerprint database is MIT. It also supports an optional `opentechalyzer db import` command that pulls in a wider, community-maintained fingerprint dataset (`enthec/webappanalyzer`), which is **GPL-3.0**. The project's own documentation states this data is fetched to the user's own machine on request and never redistributed by the project itself, so running `db import` does not relicense OpenTechAnalyzer or Metrivio's codebase — but it does mean a machine that has run `db import` is holding GPL-3.0 data locally.

**Likelihood:** Low as a legal issue (this is a well-understood, deliberately-designed license boundary, not an accidental trap), but worth a clear operating rule so it's never crossed absentmindedly.
**Impact:** Low if the rule below is followed; potentially meaningful if violated (redistributing GPL-3.0 data as part of a distributed product can trigger copyleft obligations on that distribution).

**Operating rule:** Metrivio's default deployment does **not** run `opentechalyzer db import`. The built-in MIT-licensed 588-fingerprint database already covers every technology named in the founder's brief (Shopify, Klaviyo, Gorgias, Recharge, Yotpo, Meta Pixel, GA4, GTM — all independently confirmed, RESEARCH.md §2A.7). If broader, long-tail fingerprint coverage is ever wanted beyond DTC/ecommerce-and-marketing-stack technologies, `db import` can be run on a self-hosted instance for internal use only — but no Metrivio deployment artifact (Docker image, distributable package, hosted service) should ever bundle or redistribute the resulting GPL-3.0 dataset.

---

## 3B. Reverse Lookup Deferral — Coverage and Cost Dependency Risk (Not a Blocker, Documented for V2 Planning)

**Risk:** OpenTechAnalyzer's `ota reverse` capability (technology → candidate domain list, via HTTP Archive/CrUX data queried through the user's own Google Cloud/BigQuery project) is a genuinely useful discovery-source expansion, but carries two risks worth flagging before it's ever turned on: (1) coverage skews toward higher-traffic (CrUX-tracked) sites, and the tool's own documentation states small or new stores may be absent — a direct concern for Metrivio's actual $1M–$10M ICP range; (2) it introduces a new external dependency (a Google Cloud project and its own auth/credential surface) that nothing else in this system requires.

**Likelihood:** N/A for V1 — not enabled. Relevant only once/if it's added in V2.
**Impact:** Low-Medium if added carelessly (e.g., treating a reverse-lookup hit as evidence without the mandatory direct-scan verification step); Low if the existing rule is followed (every reverse-lookup hit must pass a real `analyze()` scan before contributing to the `evidence` table, per ARCHITECTURE.md §5 and RESEARCH.md §2A.9).

**Disposition:** V2, not V1, per RESEARCH.md §2A.9 and BUILD_PLAN.md Stage 6A. This is a placement decision with documented reasoning, not an unresolved item.

---

## 3C. Licensing Boundary — LGPL-3.0-or-later Transitive Dependency in Vendored X-Manager (Stage 2 Finding)

**Risk:** The vendored X-Manager instance (`packages/content/vendor/x-manager`) depends on `next@15.5.12`, whose `package.json` lists `sharp@^0.34.3` as an **optional** dependency (used only for `next/image`'s built-in server-side image optimization). `sharp` itself is Apache-2.0, but at each supported platform it pulls in a prebuilt native binary package, `@img/sharp-libvips-<platform>@1.2.4`, whose declared license is **LGPL-3.0-or-later** — confirmed directly by inspecting `packages/content/vendor/x-manager/package-lock.json` (`node_modules/@img/sharp-libvips-*` entries, each `"license": "LGPL-3.0-or-later"`, each `"optional": true`). X-Manager's own `next.config.mjs` does not disable image optimization, and `next/image` is used in at least one component (`src/components/CreateThreadFromArticle.tsx`), so this is not a theoretical/unused transitive dependency — it is plausibly exercised at runtime once the vendored app is actually deployed in production (`output: 'standalone'` mode, where Next.js recommends installing `sharp` since no bundled fallback exists).

**Likelihood:** Low as a legal issue — this is npm's ordinary optional-native-binary distribution pattern (the same shape as `better-sqlite3`'s prebuilt binaries), and LGPL's dynamic-linking allowance is exactly the case here: `sharp` calls into libvips via prebuilt shared-library bindings, not by statically linking libvips source into a combined binary, and Metrivio does not modify libvips itself.
**Impact:** Low if the operating rule below is followed; a genuine concern only if libvips were ever statically linked into a single distributed binary, or if its source were modified without republishing those modifications.

**Operating rule:** No action is required to keep using `sharp`/`next/image` as vendored today — standard `npm install` preserves the `@img/sharp-libvips-*` packages' own license files, and dynamic linking to an unmodified LGPL-3.0 library does not extend copyleft to the calling application. Before any change that would statically bundle these native binaries into a single compiled artifact (e.g. a packaging tool that inlines native addons), re-verify this reasoning first. This entry exists because the LGPL dependency itself is real and worth a named, documented rule — not because Stage 1 had already flagged it (it had not; RISK_REGISTER.md's only licensing entries before this Stage 2 pass were §3 and §3A, both about OpenTechAnalyzer, not X-Manager).

---

## 4. Data Fabrication Risk (Prospecting)

**Risk:** An LLM-assisted enrichment or personalization step could hallucinate a revenue figure, ad spend number, technology, or founder fact not actually present in the source evidence — directly violating the brief's core constraint.

**Likelihood:** Medium if evidence-gating is not enforced at the code layer (LLMs will do this if merely instructed not to and given the option).
**Impact:** High — this is a named, explicit constraint from the founder; violating it undermines the entire premise of the ICP scoring system and could produce embarrassing/false outreach claims.

**Mitigations:**
- Evidence-gating is enforced structurally, not just via prompt instruction: personalization and scoring logic only ever read from the `evidence` table with a valid tier; there is no code path that lets a draft or a score reference a fact absent from that table.
- Every LLM call used for extraction (e.g., "does this bio suggest a founder role?") writes its output back as an `evidence` row with an explicit tier (never higher than `LIKELY` for a single unverified LLM read), rather than being treated as ground truth.
- Golden/adversarial test cases (Stage 3, Stage 10 of BUILD_PLAN.md) specifically probe for fabrication before those stages are considered done.

---

## 5. Data Fabrication Risk (Content — Case Studies / Proof)

**Risk:** The content engine could generate copy implying Metrivio has existing clients, results, or case studies, contradicting Proof Document Part B's explicit "no case studies yet, and that's fine" positioning.

**Likelihood:** Medium without an explicit check (this is a very natural LLM failure mode — writing confident-sounding marketing copy).
**Impact:** High — directly contradicts the founder's explicit instruction and could be reputationally costly if published.

**Mitigations:**
- Quality Check stage (ARCHITECTURE.md §4.1) explicitly flags "clients include," "trusted by," "results for brands like," or any language implying an established client roster, per Proof Document Part B's "language to avoid entirely" list.
- Founder-experience claims (Unilever/P&G) are only permitted when attributed to the founder personally, never phrased as Metrivio client work — checked by the same quality gate.
- All generated content passes through human approval by default regardless of the quality check's pass/fail result — the quality check is a pre-filter, not a substitute for review.

---

## 6. Evidence Tier Misapplication Risk

**Risk:** The scoring engine's evidence tiers (CONFIRMED/STRONG EVIDENCE/LIKELY/UNKNOWN) are precisely defined in the ICP document with a fixed corroboration rule. A subtle implementation bug (e.g., allowing 2+ STRONG EVIDENCE signals to round up to CONFIRMED) would silently produce inflated scores and, worse, incorrectly unlock dollar-figure disclosure language that should be gated behind CONFIRMED status.

**Likelihood:** Low once golden tests are in place; Medium during initial implementation before those tests exist.
**Impact:** High — an incorrectly "CONFIRMED" prospect could trigger outreach copy stating a specific revenue or spend figure that was never actually confirmed, which is both a factual and a credibility problem.

**Mitigations:** Stage 3 of BUILD_PLAN.md requires the golden worked-examples from ICP §22.F to pass exactly before any other code is allowed to depend on the scorer, plus explicit property tests asserting STRONG EVIDENCE can never become CONFIRMED via corroboration.

---

## 7. Cost Risk (Official X API Usage)

**Risk:** X-Manager's write path uses X's pay-per-use official API. Content publishing volume is naturally low-cost, but if Topic Discovery, engagement-inbox polling, or analytics pulls are run too frequently, costs can accumulate unexpectedly.

**Likelihood:** Low-Medium without caps.
**Impact:** Low-Medium (financial, not safety) — bounded and visible, not catastrophic, but worth surfacing.

**Mitigations:** X-Manager's built-in discovery cache (15-min TTL), result caps, and usage dashboard are used as-is; System Health dashboard section surfaces API usage/cost trend so it's visible before it becomes a surprise.

---

## 8. Restart / Duplicate-Action Risk

**Risk:** A process restart mid-sequence could, without care, re-send an outreach message or re-publish a scheduled post.

**Likelihood:** Low with the designed mitigations; Medium if skipped under time pressure.
**Impact:** Medium-High — a duplicate cold DM to a prospect who already replied "not interested" is exactly the kind of thing that damages both the prospect relationship and, at scale, account standing.

**Mitigations:** DB-level unique constraints on `(prospect_id, sequence_id, sequence_step_order)` (DATABASE.md §2) and a pre-send stop-condition re-check immediately before every send (ARCHITECTURE.md §3.1) — not just at sequence start. Chaos-tested explicitly in BUILD_PLAN.md Stage 15.

---

## 9. Credential Exposure Risk

**Risk:** X session cookies, OAuth tokens, or API keys leaking into logs, source control, or the audit trail.

**Likelihood:** Low with discipline; this is a "one careless log line" class of risk, so it needs an explicit control, not just good intentions.
**Impact:** High — a leaked session cookie or OAuth token is equivalent to full account takeover risk.

**Mitigations:** `audit_log.detail` is schema-documented as never containing credential material (DATABASE.md §4); encryption-at-rest for stored credentials (X-Manager's existing AES-256-GCM pattern, reused rather than reinvented); `.env`-based secrets never committed; Stage 15 hardening pass includes an explicit grep-for-secrets check across code and logs before considering the build production-ready.

---

## 10. Open Items (Updated Status)

**Resolved by founder decision (2026-09-04):**
- **Geography** — no hard restriction. Implemented as an empty-by-default, configurable filter (`geography_filter` in `system_config`). Not a blocker for Stage 5.
- **Vertical/category scope** — no hardcoded allow/deny list. Implemented as configurable `vertical_inclusion_rules` / `vertical_exclusion_rules`, empty by default; the ICP scoring framework (not a pre-filter list) remains the authority on fit. Not a blocker for Stage 5.
- **Company size ceiling** — no arbitrary hard ceiling. Employee count and similar scale signals feed the ICP scorer's Revenue-Fit factor as evidence, per the ICP document's own §22 framework, rather than acting as a pre-scoring exclusion gate. Not a blocker for Stage 5.

**Resolved by direct repository verification (this update):**
- **OpenTechAnalyzer's actual source.** Located, inspected, and verified at `https://github.com/Houseofmvps/opentechalyzer` — MIT-licensed, npm package `opentechalyzer@0.4.2`, Node `>=18.17`, TypeScript library + CLI + MCP server. Full capability verification in RESEARCH.md §2A. **This is no longer an open item or a blocker.**
- **Shopify Plus fingerprint status** — downgraded from "blocker" to "known minor gap, documented, not blocking." The README confirms Shopify, Klaviyo, Gorgias, Recharge, Yotpo, Meta Pixel, GA4, and GTM as named fingerprints, but does not explicitly document a distinct Shopify Plus signature separate from base Shopify detection (RESEARCH.md §2A.7). This does not block Stage 2 or any other stage — it means Shopify Plus-specific claims should be treated as unverified until checked directly against `src/fingerprints/` in the actual source during implementation, and the ICP scoring framework's existing evidence-tier system already handles this correctly (an unverified fingerprint simply doesn't produce a `DETECTED` row; it does not need special-case handling).

**No remaining blocking items identified as of this update.** Everything in the founder's most recent instruction set has been resolved either by configuration (geography/vertical/company-size), by direct verification (OpenTechAnalyzer), or by an explicit, reasoned placement decision (reverse lookup → V2, §3B above). If a genuine technical integration problem surfaces once real implementation begins against the live `opentechalyzer` package (as opposed to its documentation), it will be raised here specifically, rather than assumed in advance.

**New open item raised during Stage 2 (technology enrichment implementation) — not blocking, flagged rather than silently resolved:**
- **`technology_change_events.change_type = 'version_changed'` is not implementable against the current adapter contract.** DATABASE.md documents three change types (`added` / `removed` / `version_changed`), and OpenTechAnalyzer's own `Detection.version` field is available at the library level. However, the Stage-1-authored adapter-contract types in `packages/core/src/adapters/tech-analyzer-adapter.ts` (`TechnologyResult`, `TechEvidenceItem`) carry no `version` field anywhere, and neither does the `technology_detections` table. Stage 2 therefore implements `added`/`removed` change detection only (both fully covered by the existing contract) and does not implement `version_changed`, rather than silently widening the adapter contract or the schema to add one. **Recommended fix for a future stage:** add an optional `version?: string` field to `TechnologyResult` (populated from OpenTechAnalyzer's own `Detection.version`) and a corresponding nullable `technology_version` column on `technology_detections`, then extend the diff in `packages/prospecting/src/enrichment/technology-enrichment.ts` to compare versions for technologies present in both scans. This is called out here rather than made unilaterally, per the instruction to stop and report a needed schema/contract addition instead of making it silently.
