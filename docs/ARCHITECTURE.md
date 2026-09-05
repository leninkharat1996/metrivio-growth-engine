# ARCHITECTURE.md — Metrivio X Growth Engine

**Depends on:** RESEARCH.md (tooling decisions referenced below assume that document's conclusions)

---

## 1. Design Principles

1. **Adapters around everything fragile.** X's scraping surface, X's official API, and technology-detection all change or break on someone else's schedule, not ours. Every integration point is an interface with a single implementation swapped in, never called directly from business logic.
2. **Evidence-first, not inference-first.** Every fact stored about a prospect (revenue, spend, technology, role, trigger) carries an evidence tier and a source. The ICP scorer consumes evidence tiers, never raw guesses.
3. **Read and write are architecturally separate.** Reading public X data (discovery, enrichment) and writing to X (posting, DMing, following) have different risk profiles, different rate limits, and different compliance postures. They use different adapters and can be toggled independently.
4. **Automation level is a configuration decision, not an architectural one.** Both outreach and content publishing support three modes — `dry_run`, `approval_required`, `autonomous` — selectable independently, per subsystem, at any time. The system ships with safe defaults (`dry_run` on first boot) but every pipeline stage is written to run correctly, with full reliability controls (limits, retries, dedup, session health checks), under `autonomous` mode as a fully supported end state. Nothing about automated X prospecting or automated X outreach is removed or artificially restrained by the codebase itself — the founder controls the dial, the code doesn't pre-decide it.
5. **One database, two subsystems.** Prospecting and content share a SQLite database and a single audit-log table, but are otherwise independent modules — a content-engine outage should not block outreach, and vice versa.
6. **Deterministic scoring, generative everything else.** The ICP scoring math (weights, tiers, bands) is plain TypeScript with no model calls and 100% unit-test coverage. LLM calls are used only to *extract* evidence from unstructured text (a bio, a post) — never to compute or adjust a score.
7. **Filters are configuration, not code.** Geography, vertical/category inclusion or exclusion, and company-size signals are all read from `SystemConfig` at Discover-time and from the ICP scoring evidence tables — none of them are hardcoded lists, hardcoded ceilings, or hardcoded regions inside pipeline logic. Default state for all three is "no additional restriction beyond what the ICP scoring framework itself defines."

---

## 2. High-Level System Diagram (textual)

```
                         ┌─────────────────────────────────────────┐
                         │              Dashboard (Next.js)          │
                         │  Overview / Prospects / Outreach /        │
                         │  Conversations / Content / Analytics /    │
                         │  Settings / System Health                 │
                         └───────────────┬───────────────────────────┘
                                          │ REST + SSE
                    ┌─────────────────────┴─────────────────────┐
                    │                Core API (Node/TS)           │
                    │   orchestrates both subsystems, owns the    │
                    │   audit log, config, kill switch             │
                    └───┬───────────────────────────────┬─────────┘
                        │                               │
        ┌───────────────┴───────────────┐   ┌───────────┴────────────────┐
        │      PROSPECTING SUBSYSTEM      │   │       CONTENT SUBSYSTEM      │
        │                                  │   │                              │
        │  Discovery → Enrichment →        │   │  Research → Idea → Draft →   │
        │  Verify → Score → Personalize →  │   │  Quality Check → Approval →  │
        │  Outreach → Follow-up →          │   │  Schedule → Publish →        │
        │  Reply Detection → Stop/Continue │   │  Analyze                     │
        │                                  │   │                              │
        │  - ICP Scoring Engine (pure TS)  │   │  - Content Research module   │
        │  - Evidence Store                │   │  - Draft Generator (Claude)  │
        │  - Sequence Engine                │   │  - Quality Checker           │
        │  - Conversation Classifier        │   │  - X-Manager (vendored)      │
        └───────┬─────────────┬────────────┘   │    scheduler/publisher/      │
                │             │                 │    analytics/approval        │
     ┌──────────┴───┐   ┌─────┴──────────┐      └──────────────┬───────────────┘
     │ XReadAdapter  │   │ TechAnalyzer   │                     │
     │ (discovery,   │   │ Adapter        │                     │ XWriteAdapter
     │  enrichment,  │   │                │                     │ (posting/DM,
     │  engagement)  │   │                │                     │  automation-mode aware)
     └──────┬────────┘   └──────┬─────────┘                     └──────┬────────┘
            │                   │                                       │
    ┌───────┴────────┐  ┌───────┴─────────────┐               ┌────────┴────────────┐
    │ XActions (impl) │  │ OpenTechAnalyzer     │               │ X-Manager (impl,     │
    │ twscrape (impl,  │  │  (Houseofmvps/       │               │  official API) for   │
    │  fallback)       │  │  opentechalyzer,     │               │  post/schedule/reply │
    │                  │  │  MIT, verified —      │               │ XActions write-path  │
    │                  │  │  PRIMARY, integrated  │               │  (impl) for DM send  │
    │                  │  │  as a direct library  │               └──────────┬───────────┘
    │                  │  │  dependency, not a    │                          │
    │                  │  │  subprocess)          │               ┌──────────┴───────────┐
    │                  │  │ wappalyzergo (impl,   │               │ Session Health         │
    │                  │  │  fallback, subprocess)│               │ Monitor (auth validity,│
    │                  │  └───────────────────────┘               │ rate-limit headroom,   │
    │                  │                      │                    │ error-rate tracking)    │
    └─────────────────┘                       │                    └──────────┬───────────┘
                                  ┌────────────┴───────────────────────────────┴──┐
                                  │              SQLite (WAL) + audit log            │
                                  └───────────────────────────────────────────────┘
```

---

## 2C. Final Flow Diagrams (as requested, exact shape)

**X Prospecting Flow:**

```
X Search / X Discovery
        ↓
X Profile + Post Enrichment            (XReadAdapter; OpenTechAnalyzer render/crawl defaults apply once a domain is known)
        ↓
Founder / Decision-Maker Verification  (cheap check before expensive ones)
        ↓
Company Identification                 (name + domain, evidence-tiered)
        ↓
Company Domain
        ↓
OpenTechAnalyzer                       (analyze()/analyzeMany(), primary TechAnalyzerAdapter implementation)
        ↓
Technology Evidence                    (DETECTED/NOT_DETECTED/BLOCKED/ERROR/INCONCLUSIVE, never collapsed)
        ↓
Metrivio Evidence Engine               (evidence table — technology evidence joins revenue/spend/maturity/
        ↓                               decision-maker/trigger/DTC evidence already gathered from X-side signals)
Metrivio ICP Score                     (deterministic scorer, ICP §22, unchanged)
        ↓
A / B / C / Reject
        ↓
Personalization                        (evidence-gated — can cite a specific tech signal, e.g. "saw you're on
        ↓                               Shopify Plus + Klaviyo," only if that evidence row actually exists)
X Outreach                             (XWriteAdapter, automation_mode-aware)
```

**X Content Flow (separate pipeline, converges into the prospecting flow above via engagement):**

```
X Content Research
        ↓
Content Ideas
        ↓
Draft
        ↓
Human Approval
        ↓
Publish
        ↓
Analytics
        ↓
Engagement
        ↓
Relevant Engaged Accounts
        ↓
X Prospect Qualification Pipeline      (re-enters the prospecting flow above at "X Profile + Post Enrichment,"
                                         tagged source: content_engagement — identical evidence/exclusion rules,
                                         no lower bar)
```

Technology evidence is one input to the Metrivio Evidence Engine, never a shortcut around it: a DETECTED Shopify Plus + Klaviyo result does not itself qualify a prospect — it becomes one or more evidence rows that feed the existing, unchanged ICP §22 factors (chiefly Maturity, and Revenue-Fit's technology-adjacent signal categories), exactly as before. No new scoring criteria have been introduced because OpenTechAnalyzer exposes more data than originally assumed — see RESEARCH.md §2A.8 for the explicit CORE/USEFUL/OPTIONAL/NOT_NEEDED classification that keeps this boundary honest.

---

## 3. Subsystem: Prospecting + Outbound

### 3.1 Pipeline stages (Discover → Enrich → Verify → Score → Personalize → Outreach → Follow-up → Reply Detection → Stop/Continue)

- **Discover** — runs configured search jobs (keyword, founder-pattern, pain/intent, and account-graph queries from ICP §1–3 categories) through `XReadAdapter`. Each discovery run is logged with its query, source, and timestamp. Output: raw candidate handles + the specific tweet/profile that surfaced them (the evidence). Discovery queries are shaped by three independently configurable filter sets, none of which are hardcoded and none of which restrict anything by default: a **geography filter** (empty/no restriction by default — can later be set to bias or exclude by region for time zone/language/legal-jurisdiction reasons), a **vertical inclusion/exclusion list** (empty by default — DTC/ecommerce remains the target per the ICP document, but no specific product category is hardcoded as allowed or disallowed), and **company-size signals**, which are never a hard ceiling — employee-count and similar signals feed the ICP scorer's Revenue-Fit factor as evidence, exactly as the ICP document's §22 framework defines, rather than being used as a pre-scoring exclusion gate.
- **Enrich** — pulls profile fields (bio, follower/following counts, recent posts, website) via `XReadAdapter`. If a website/domain is present, it's handed to `TechAnalyzerAdapter`, which calls OpenTechAnalyzer's `analyze()` (or `analyzeMany()` for batches) **as a direct in-process TypeScript library call**, not a CLI shell-out — both this application and OpenTechAnalyzer are Node/TypeScript, so no subprocess or stdout-parsing is needed for the primary path. Scans default to `render: true` (Playwright) and `crawl: 5` with `fields: ['contact', 'social', 'company']` when a domain is scanned for the first time, since Meta Pixel/GTM are frequently tag-manager-injected (needs render) and contact/social/company fields live on inner pages (needs crawl) — see RESEARCH.md §2A.6. Every enrichment call and its raw response is stored (see DATABASE.md `evidence` and `technology_scans` tables) — nothing here is inferred, only captured.
- **Founder / Decision-Maker Verification** — a distinct check, run after profile enrichment and before company identification: does this account's role/bio/activity plausibly indicate budget authority (ICP §1, §21)? This gate exists so an execution-only title (coordinator, specialist, assistant) doesn't proceed to consume a technology scan or a scoring run before it's even a plausible decision-maker — cheap checks first, expensive ones later.
- **Company Identification** — combines evidence already gathered (bio text, linked website, X-extracted structured signals) into a company name + domain, tagged with a confidence tier per ICP §5. `companyName` sourced from a target site's own structured data (via OpenTechAnalyzer's `company` field set) is treated as strong, near-primary-source evidence for identification purposes specifically; `inferredCompanyName` (a title-based guess) is capped at `LIKELY`, per RESEARCH.md §2A.8.
- **Verify** — applies the ICP §15 exclusion checks and the evidence-confidence rules from ICP §4/§5 *before* scoring. A prospect that fails exclusion never reaches the scorer (matches "Exclusions checked first").
- **Score** — pure-function ICP Scoring Engine (§4 below) consumes the evidence rows and produces a score, tier, and a structured justification object — never a bare number.
- **Personalize** — the personalization generator is only allowed to reference fields that exist in the `evidence` table with a non-UNKNOWN tier for *that specific prospect*. If no usable evidence exists, the system returns "insufficient evidence for personalization" rather than falling back to a generic template — this is enforced in code, not left to prompt instructions alone.
- **Outreach / Follow-up** — the Sequence Engine (§3.2) reads configurable, per-sequence day offsets and sends the next scheduled message only if the prospect's conversation state is still `active` (see Stop/Continue). All sends go through `XWriteAdapter`, and the send path itself is fully automatable: under `automation_mode = autonomous`, the sequence engine sends without a human approval step, subject to daily/action limits, the kill switch, and the Session Health Monitor (§3.5) refusing sends if the connected account shows signs of degraded standing (elevated error rate, auth failures, unexpected rate-limit responses).
- **Reply Detection** — polls (or, once available, subscribes to) DMs/mentions via `XWriteAdapter`'s read-back capability or a scheduled `XReadAdapter` check, classifies each new message with the Conversation Classifier (§3.3), and updates conversation state.
- **Stop/Continue** — a prospect's sequence halts immediately and permanently on: any reply, an explicit opt-out/not-interested classification, manual disqualification, or a global kill-switch/campaign-stop. This check runs immediately before every send, not just at sequence-start.

### 3.2 Sequence Engine

- Sequences are configuration, not code: a JSON/DB-defined list of `{ day_offset, template_id, condition }` steps per campaign.
- Before every send: re-check conversation state, re-check daily/campaign send limits, re-check kill switch, re-check dedup (has this exact prospect+step already been sent — protects against duplicate sends on restart).
- All sends are idempotent: each (prospect_id, sequence_step_id) pair has a unique constraint in the outreach log, so a crash-and-restart cannot double-send.

### 3.3 Conversation Classifier

- Classifies inbound replies into: `POSITIVE / INTERESTED / QUESTION / NEUTRAL / NOT_INTERESTED / OPT_OUT / SPAM / UNKNOWN`.
- Implementation: a small, deterministic keyword/pattern layer for unambiguous cases (explicit opt-out phrases, unsubscribe-style language) checked first and always wins regardless of model output, backed by an LLM classifier (Claude) for everything else, with `UNKNOWN` as the safe default when confidence is low. `OPT_OUT` and `NOT_INTERESTED` always stop the sequence; the deterministic layer exists specifically so an opt-out is never missed due to a model misclassification.

### 3.4 ICP Scoring Engine

- Implements ICP document §22 exactly: fixed factor weights (Revenue-Fit 25 / Paid Acquisition 25 / Maturity 15 / Decision-maker 15 / Trigger 15 / DTC fit 5), the evidence-tier multiplier table (CONFIRMED 100% / STRONG EVIDENCE 80% / LIKELY 40% / UNKNOWN 0%), the fixed corroboration rule (≥2 signal categories = STRONG EVIDENCE, never upgraded to CONFIRMED by corroboration), the checklist-factor point tables, the trigger-verification rule (a claimed "ad volume increase" only counts with two dated observations), and the score bands (A/B/C/Reject).
- Exclusions (§15) run first and short-circuit scoring entirely, exactly as specified.
- Every score output is `{ score, tier, factor_breakdown[], evidence_tier_per_factor, revenue_disclosure_status, spend_disclosure_status, missing_evidence[], recommended_action }` — never a bare number, matching the "no black box" requirement.
- 100% unit-tested against the worked examples in ICP document §22.F as golden test cases (90-A boundary, 95-A confirmed path, 83-B, 63-C, both Reject cases) before any other code depends on it.

### 3.5 Session Health Monitor

Exists specifically to make `autonomous` mode safe to run unattended, per the founder's instruction that automation should be enabled, not withheld — a monitor rather than a restriction:

- Tracks, per connected X account/session: recent error rate on write calls, auth-failure occurrences, X-reported rate-limit headroom (read from response headers where the adapter exposes them), and time-since-last-successful-action.
- Exposes a simple health state — `healthy` / `degraded` / `at_risk` — surfaced on the System Health dashboard section (Part 19).
- `degraded` triggers a configurable automatic slowdown (wider spacing between sends) rather than a hard stop. `at_risk` triggers an automatic drop to `approval_required` mode for that account until a human clears it — this is a safety behavior, not a permanent restriction, and is itself configurable (a founder who wants pure autonomous behavior regardless can disable the auto-downgrade, understanding the tradeoff).
- All health-state transitions are written to the audit log so account-health history is reviewable after the fact.

---

## 4. Subsystem: Content

### 4.1 Pipeline stages (Research → Idea → Draft → Quality Check → Human Approval → Schedule → Publish → Analyze)

- **Research** — pulls candidate conversations/topics via `XReadAdapter` (keyword/topic search across the 15 content pillars) and via engaged-account signals from the prospecting subsystem (Part 17 loop, §5 below). Also ingests analytics from prior posts (§4.3) to bias toward what has worked.
- **Idea** — structures each research hit into `{ topic, source, why_it_matters, target_audience, hook, angle, recommended_format }`, per the brief's required idea schema.
- **Draft** — generates Hook A/B/C, then the full post, using Metrivio's offer/ICP/proof documents as grounding context so claims stay inside what Document 1/3 permit (no fabricated stats, no implied case studies, no claims beyond founder-experience framing).
- **Quality Check** — an automated pass that rejects/flags drafts containing: fabricated statistics, implied client results or "clients include" language, emoji overuse, generic AI phrasing patterns, unsupported superlatives, or any STOP/FIX/SCALE/TEST/REALLOCATE claim asserted as fact about a real named company without evidence.
- **Human Approval** — default gate; nothing moves to Schedule without an explicit approve action, unless `autonomous_publishing = true` is set for a given queue (off by default, config-visible in Settings).
- **Schedule / Publish** — delegated to the vendored X-Manager instance's scheduler + Bridge API, via `XWriteAdapter`.
- **Analyze** — pulls X-Manager's analytics endpoints (impressions, likes, replies, reposts, bookmarks, follower growth, best posting times) on a schedule and feeds a rollup back into Research to bias future idea generation toward what performs (§16 of the brief).

### 4.2 Content pillars & formats

Implemented as configuration (a list of the 15 pillars and permitted formats from the brief), not hardcoded logic — editable without a redeploy.

### 4.3 Analytics feedback loop

A scheduled job aggregates published-post performance by pillar, hook style, and format, and writes a "what's working" summary consumed by the Idea stage — this satisfies Part 16's "feed findings back into content generation" requirement without needing a separate ML component.

---

## 5. Content → Prospecting Loop (Part 17)

When a published post receives engagement (reply, quote, like — whatever `XReadAdapter`/X-Manager's engagement inbox can surface), a job:

1. Identifies the engaging account (via the engagement inbox / mention stream).
2. Hands that account into the **same** Discover→Enrich→Verify→Score pipeline used for cold discovery (§3.1) — engaged accounts are not a separate, lower-bar pipeline; they go through identical evidence and exclusion rules.
3. If scored A/B, the prospect record notes its origin as `source: content_engagement` with a link to the specific reply/post — this is itself a legitimate, evidenced "why now" signal per ICP §16 ("visible funnel/offer changes," founder-stated pain, etc., when the reply text itself constitutes the evidence).

**Note on OpenTechAnalyzer's change-tracking (`ota watch`):** where a prospect's company domain is already known and has been scanned before, a scheduled re-scan's diff (technology added/removed/version-changed) is a second, independent source of dated "why now" evidence, feeding the same ICP §16 trigger-verification rule (which requires two dated observations before a change counts as a trigger) — this is wired into the Enrichment stage (§3.1), not a separate pipeline, since it's just a second `analyze()` call against a domain already in the system.

**Note on reverse lookup:** OpenTechAnalyzer's `ota reverse` (technology→candidate-domain lookup via HTTP Archive/BigQuery) is a legitimate future *additional* discovery source, evaluated in RESEARCH.md §2A.9 and deferred to V2 — not included in this diagram or in V1 scope. If added later, it would feed into "X Search / X Discovery" as one more candidate source, with every hit still required to pass a direct `analyze()` verification scan before any evidence is written, exactly like every other discovery method.

---

## 6. Adapter Interfaces (contract-level, implementation-agnostic)

```ts
interface XReadAdapter {
  searchTweets(query: string, opts): Promise<TweetResult[]>;
  getProfile(handle: string): Promise<ProfileResult>;
  getFollowers(handle: string, opts): Promise<AccountResult[]>;
  getFollowing(handle: string, opts): Promise<AccountResult[]>;
  getTweets(handle: string, opts): Promise<TweetResult[]>;
  getListMembers(listUrl: string): Promise<AccountResult[]>;
  getEngagers(tweetUrl: string): Promise<AccountResult[]>; // likers/repliers/quoters
}

interface XWriteAdapter {
  postTweet(content, opts): Promise<PostResult>;
  postThread(contents[], opts): Promise<PostResult[]>;
  sendDM(handle, content): Promise<DMResult>;
  replyTo(tweetId, content): Promise<PostResult>;
  getInboxSince(timestamp): Promise<InboxItem[]>; // mentions/DMs/replies for reply detection
  getSessionHealth(): Promise<SessionHealthResult>; // feeds the Session Health Monitor
}

interface TechAnalyzerAdapter {
  analyze(domain: string, opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult>;
  analyzeMany(domains: string[], opts?: TechAnalyzeOptions): Promise<TechAnalyzerResult[]>;
}

interface TechAnalyzerResult {
  scanStatus: 'OK' | 'BLOCKED' | 'ERROR' | 'INCONCLUSIVE'; // did the scan itself succeed
  technologies: {
    name: string;
    status: 'DETECTED' | 'NOT_DETECTED'; // only meaningful when scanStatus === 'OK'
    confidence: number; // 0-100, from the underlying detector's probabilistic combination
    accountIds?: string[];
    evidence: { source: string; subject: string; match: string; reliability: number }[];
  }[];
  enrichment?: { company?: object; social?: object; contact?: object; locale?: object }; // optional field sets
  detector: 'open_tech_analyzer' | 'wappalyzergo';
  timestamp: string;
}
```

**The scan-level/technology-level distinction is deliberate and important:** `scanStatus` records whether the analysis itself succeeded at all (a domain that can't be reached, times out, or blocks the request is `BLOCKED`/`ERROR`/`INCONCLUSIVE` at the *scan* level, and no per-technology row is written for that scan). Only once `scanStatus === 'OK'` does a technology's absence from the result mean `NOT_DETECTED` — a legitimate, positive finding from a scan that actually ran, not a failure being relabeled. This satisfies the instruction to never convert `BLOCKED`/`ERROR`/`INCONCLUSIVE` into `NOT_DETECTED`: the two are structurally different fields, not different values of the same field, so the mistake isn't representable in the type.

- `TechAnalyzerAdapter` implementation — **primary: `OpenTechAnalyzerAdapter`**, wrapping the `analyze`/`analyzeMany` functions imported directly from the `opentechalyzer` npm package (in-process, no subprocess — both are TypeScript). Verified via direct repository inspection: MIT license, npm package `opentechalyzer@0.4.2`, Node `>=18.17` (RESEARCH.md §2A). **Fallback: `WappalyzerGoAdapter`**, shelling out to a pinned wappalyzergo binary/CLI, kept in reserve specifically because OpenTechAnalyzer is itself a small (1–2 star), newer project — a legitimate bus-factor diversification reason, not a capability or license concern (RISK_REGISTER.md).
- `XReadAdapter` implementations: `XActionsReadAdapter` (primary), `TwscrapeReadAdapter` (fallback, Python service called over a local HTTP shim if/when enabled).
- `XWriteAdapter` implementations — **two, routed by action type and config, not one:**
  - `XManagerWriteAdapter` — calls the vendored X-Manager instance's Bridge API and scheduler endpoints (official X API). Used for `postTweet`, `postThread`, `replyTo`, and scheduling. This is the default path wherever the official API supports the action, since it's the most ToS-compliant and reliable route.
  - `XActionsWriteAdapter` — calls XActions' session-based write tool group. Used for `sendDM` (official-API DM access is generally gated behind an elevated tier most bootstrap accounts won't have) and available as a configurable alternate path for posting/replying if the founder prefers to keep everything on one adapter. Every call through this adapter is subject to the Session Health Monitor and the configured `automation_mode`.
  - Both implementations satisfy the same interface, so the dashboard/pipeline code calling `XWriteAdapter` never needs to know which one handled a given action — only the audit log and Settings need to expose which path is active per action type.

Swapping any implementation (e.g., replacing XActions with twscrape as primary read adapter, or changing which write adapter handles which action type) means writing/reconfiguring a class against the same interface — no changes to pipeline, scoring, or dashboard code.

---

## 7. Automation Controls (cross-cutting, Part 20)

Implemented as a single `SystemConfig` table (see DATABASE.md) read by both subsystems. Every control below is genuinely configurable at runtime through Settings — none require a code change or redeploy to adjust.

| Control | Effect |
|---|---|
| `automation_mode` (per subsystem: `prospecting.outreach`, `content.publishing`) | Tri-state: `dry_run` (logged/simulated, nothing actually sent — default on first boot), `approval_required` (queues for human approval before send/publish), `autonomous` (sends/publishes without a human step, subject to every other control on this list). All three modes are fully implemented, tested, and supported — `autonomous` is a first-class end state, not a stripped-down or discouraged path. |
| `kill_switch` | Single global flag; when set, every write-adapter call is refused before it reaches the adapter, regardless of `automation_mode` or any other setting. This is the one control that always overrides everything else. |
| `daily_action_limits` | Per-action-type caps (DMs sent, follows, posts published, profiles scraped), configurable per action type, enforced in a limiter that runs before every write/scrape call and persists its counters so a restart doesn't reset the day's usage. Defaults are conservative but are plain numbers in Settings, not hardcoded — raise or lower them freely. |
| `session_health_auto_downgrade` | Whether a `degraded`/`at_risk` Session Health state (§3.5) is allowed to automatically slow down or temporarily downgrade `autonomous` to `approval_required` for that account. On by default as a safety net; can be disabled if full autonomous behavior is preferred regardless of health signal. |
| `retry_policy` | Exponential backoff with a max-attempt cap per job type; failures beyond the cap move to a `failed_jobs` queue for manual review, never silently dropped. |
| `geography_filter` / `vertical_rules` / `company_size_signal_only` | Discovery-time filters described in §3.1 — all empty/unrestricted by default, all editable in Settings without touching code. |

---

## 8. Technology Stack

- **Language/runtime:** Node.js + TypeScript across the core app, prospecting subsystem, and the vendored content/publishing subsystem (X-Manager is already Next.js/TS) — one runtime, one deployable unit, minimal operational surface.
- **Database:** SQLite (WAL mode) via Drizzle ORM — matches X-Manager's existing schema approach, zero external services, easy backup (copy the file).
- **Read scraping:** XActions (Node), pinned to a specific tagged release/commit, not `main`.
- **Fallback read scraping:** twscrape (Python), run as an isolated local service only if/when enabled — kept out of the critical path by default to avoid a two-runtime deployment unless proven necessary.
- **Write/publish:** vendored X-Manager instance (Next.js/TS, official X API, OAuth 1.0a) for posting/scheduling/replying, accessed only via its Bridge API; XActions session-based write path for DM sending, accessed only through `XWriteAdapter`.
- **Tech detection:** OpenTechAnalyzer (`opentechalyzer` npm package, MIT, verified — RESEARCH.md §2A), integrated as a **direct TypeScript library dependency** (`analyze`/`analyzeMany`), not a subprocess — both codebases are Node/TS. Optional Playwright peer dependency installed and enabled by default for render-mode scans (needed for reliable Meta Pixel/GTM detection). wappalyzergo (Go binary) remains available as a subprocess-based fallback only.
- **LLM (drafting, classification, evidence extraction):** Claude via the Anthropic API — used for generative and classification tasks only, never for the deterministic ICP score arithmetic.
- **Dashboard:** extends X-Manager's existing Next.js dashboard with new Prospects/Qualified Prospects/Outreach/Conversations sections, sharing its auth and encryption-at-rest patterns.
- **Testing:** Vitest (matches both upstream projects' existing test tooling).

---

## 9. What Is Explicitly Out of Scope

- No LinkedIn integration of any kind.
- No Apollo or any other third-party contact-enrichment vendor.
- No revenue/spend/technology/founder-fact fabrication anywhere in the pipeline, at any evidence tier, under any circumstance.
- No hardcoded geography restriction, vertical/category allowlist, or company-size ceiling anywhere in pipeline logic — these are configuration, per §3.1/§7, defaulting to unrestricted.

**Clarification on outreach automation (updated from the prior draft of this document):** automated X prospecting and automated X outreach, including DM sending, are in scope and are first-class, fully supported capabilities of this system — not something withheld due to platform-policy risk. What remains explicitly out of scope is a narrower set of specific *engagement mechanics*: bulk mass-follow/unfollow campaigns, auto-like farming, and auto-commenting used purely for growth/visibility rather than genuine, evidence-based outreach. These specific mechanics are excluded because they are a different capability than the evidence-gated outreach this system is built around, not because outreach automation in general is restrained — see RISK_REGISTER.md for the full reasoning and the configurable controls (automation_mode, limits, session health, kill switch) that make autonomous outreach operable.
