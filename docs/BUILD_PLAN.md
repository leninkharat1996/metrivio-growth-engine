# BUILD_PLAN.md — Staged Build Order

Per instruction, this is a staged plan, not a request to build everything at once. Each stage ends with tests run, failures inspected and fixed, and a short written note on what works vs. what is not yet implemented before moving to the next stage. **No stage beyond Stage 0 begins until this document, RESEARCH.md, ARCHITECTURE.md, DATABASE.md, and RISK_REGISTER.md are reviewed and approved.**

---

## Stage 0 — Foundation (current stage, this deliverable)
- Inspect repository (done — greenfield, no existing code).
- Research existing GitHub tooling (RESEARCH.md).
- Produce architecture, schema, build plan, and risk register (this set of documents).
- **Stop and present for review** before writing implementation code.

## Stage 1 — Project Scaffolding
- Initialize the Node/TypeScript monorepo (workspaces: `core`, `prospecting`, `content`, `adapters`, `dashboard`).
- Vendor X-Manager as the `content`/publishing base (fork or git-subtree, pinned to a specific tag), rather than copy-pasting its code — keeps upstream security fixes mergeable.
- Set up SQLite + Drizzle per DATABASE.md, with migrations.
- Set up Vitest, linting, and CI skeleton.
- Set up `.env.example` with every credential the system will need, and confirm none are committed.
- **Exit criteria:** `npm test` runs (even with near-zero tests), app boots with `dry_run=true` and `kill_switch` respected as a no-op smoke test, database migrates cleanly from empty.

## Stage 2 — Adapters
- Implement `XReadAdapter` backed by a pinned XActions version; implement the same interface as a stub/mock for testing without hitting X at all.
- Implement `TechAnalyzerAdapter` with **OpenTechAnalyzer (`opentechalyzer` npm package, verified MIT, RESEARCH.md §2A) as the primary implementation**, integrated as a direct library dependency calling `analyze()`/`analyzeMany()` in-process — no subprocess needed. Implement `wappalyzergo` as the fallback implementation (subprocess-based, since it's a Go binary). Re-run OpenTechAnalyzer's own `npm run benchmark` as part of this stage's testing, rather than taking its published accuracy numbers on faith (RESEARCH.md §2A.10). Explicit tests confirm: (a) a failed/blocked/timed-out scan produces a `technology_scans` row with `scan_status ≠ OK` and zero `technology_detections` rows — never a `NOT_DETECTED` row standing in for a failure; (b) a successful scan's `NOT_DETECTED` results are trusted as real negatives.
- Implement `XWriteAdapter` with two backends: `XManagerWriteAdapter` (vendored X-Manager Bridge API — posting/scheduling/replying) and `XActionsWriteAdapter` (XActions session-based write path — DM sending). Both default to `dry_run` (logs the would-be action, does not call X) until `automation_mode` is explicitly changed.
- Implement the Session Health Monitor and wire it to refuse/downgrade `autonomous`-mode sends per ARCHITECTURE.md §3.5.
- **Exit criteria:** each adapter has unit tests against mocked HTTP/subprocess/library responses, and an integration test path (manually run, not in CI) documented for hitting the real X surface and real OpenTechAnalyzer scans, kept separate from automated tests to avoid rate-limit/ban exposure and live-network flakiness during CI. Session Health Monitor tests confirm degraded/at-risk states trigger the configured downgrade behavior and that disabling `session_health_auto_downgrade` correctly suppresses it.

## Stage 3 — ICP Scoring Engine
- Implement the deterministic scorer exactly per ICP document §22, as a pure function with no I/O.
- Golden tests: all six worked examples from ICP §22.F (90-A, 95-A, 83-B, 63-C, Reject-exclusion, Reject-score) must reproduce the documented totals exactly.
- Property tests: exclusion always short-circuits scoring; UNKNOWN tier always yields 0 points for that factor with no partial credit; STRONG EVIDENCE never silently becomes CONFIRMED.
- **Exit criteria:** 100% branch coverage on the scoring module, all golden tests passing, code reviewed against the ICP document line by line.

## Stage 4 — Prospect Database + Evidence Model
- Implement `prospects`, `evidence`, `technology_scans`, `icp_scores`, `pain_signals` tables and their repository/access layer.
- Implement deduplication logic (§5 of DATABASE.md) with tests covering: same person found via two different searches, handle change between scrapes, re-scoring appending rather than overwriting.
- **Exit criteria:** dedup tests pass; evidence rows are provably append-only (no UPDATE path exists on `evidence` rows, only INSERT).

## Stage 5 — X Discovery
- Implement the four discovery methods from Part 3 (keyword, founder, pain/intent, account-graph) as configurable job definitions calling `XReadAdapter`.
- Log every discovery run (query, source, timestamp, result count) regardless of outcome — including zero-result runs, so "nothing found" is visible rather than indistinguishable from "job didn't run."
- **Exit criteria:** discovery jobs run against a mock adapter in CI and against the real adapter manually, producing prospect stub records with source evidence populated.

## Stage 6 — Enrichment
- Implement profile enrichment, technology scanning trigger (OpenTechAnalyzer `analyze()` with `render: true`, `crawl: 5`, `fields: ['contact', 'social', 'company']` as the default first-scan configuration per RESEARCH.md §2A.6), and company-identification evidence capture (Parts 4–6).
- Enforce the evidence-confidence rules from ICP §4 at the point of capture (tag every claim immediately, never leave a claim untagged) — including the `companyName` (structured-data, high tier) vs. `inferredCompanyName` (guess, capped at `LIKELY`) distinction confirmed in RESEARCH.md §2A.8.
- Implement the `technology_change_events` diffing job (DATABASE.md §1) so a domain re-scanned later in the pipeline automatically produces trigger evidence when a technology is added/removed/version-changed between two successful scans.
- **Exit criteria:** enrichment tests confirm no field is ever written without a corresponding `evidence` row and tier; a test scan against a mocked failed response produces zero `technology_detections` rows and a non-`OK` `technology_scans` row, never a `NOT_DETECTED` row.

## Stage 6A — Reverse Lookup (Deferred to V2, Not Part of Initial Scope)
- Explicitly not built in the initial version, per RESEARCH.md §2A.9. Documented here as a placeholder stage so it isn't forgotten or silently dropped: once Stages 5–7 are proven out with real qualified prospects from X-native discovery, `ota reverse` can be added as one more Discover-stage input (technology combination → candidate domain list), with every hit required to pass a direct `analyze()` verification scan before anything reaches the `evidence` table.
- Requires a founder-provided Google Cloud project and authentication before this stage can begin — a new operational dependency, not something to set up speculatively.

## Stage 7 — Scoring Integration + Prospect Dashboard (read-only)
- Wire discovery + enrichment output into the Stage 3 scorer, persisting `icp_scores`.
- Build the read-only Prospects and Qualified Prospects dashboard views (Part 19), showing score, tier, and full justification — not a bare number.
- **Exit criteria:** end-to-end test: mock discovery → mock enrichment → real scorer → dashboard shows correct tier and justification.

## Stage 8 — Outreach Engine
- Implement sequence engine, personalization generator (evidence-gated), send logic through `XWriteAdapter` (dry-run first), stop-condition checks, and the outreach/conversation tables.
- Implement duplicate-send prevention via the DB unique constraint and an explicit "already sent this step" pre-check.
- Implement and test all three `automation_mode` states end-to-end for outreach, including `autonomous` — this is a required deliverable of this stage, not an optional stretch goal.
- **Exit criteria:** simulated restart-mid-sequence test proves no duplicate sends; a simulated reply immediately halts further scheduled sends in the same test run; a full `autonomous`-mode run against a mocked adapter sends correctly-paced messages respecting daily limits and session health without requiring any human approval step.

## Stage 9 — Conversation Intelligence
- Implement the deterministic opt-out/unsubscribe keyword layer (always wins) plus the Claude-backed classifier for the rest of the taxonomy (Part 18).
- Surface `INTERESTED`/`POSITIVE` conversations prominently in the dashboard.
- **Exit criteria:** opt-out phrases are caught 100% of the time in tests even when the LLM classifier is mocked to return something else — the deterministic layer must win the conflict.

## Stage 10 — Content Engine (Research → Idea → Draft → Quality Check)
- Implement research/idea/draft generation grounded in the Metrivio offer/ICP/proof documents, with the quality-check rules from ARCHITECTURE.md §4.1 as automated pre-approval checks.
- **Exit criteria:** test corpus of intentionally bad drafts (fabricated stat, "clients include X," excessive emoji, generic AI phrasing) are all flagged by the quality checker.

## Stage 11 — Publishing Integration
- Wire the content engine's approved drafts into the vendored X-Manager's draft/approval/schedule/publish flow via its API, defaulting to human approval, with `autonomous_publishing` as an explicit opt-in per queue.
- **Exit criteria:** a draft cannot reach `scheduled` status without an `approved` record in `content_drafts`, enforced at the database/service layer, not just the UI.

## Stage 12 — Analytics + Feedback Loop
- Wire X-Manager's analytics endpoints into `content_performance_rollup`, and feed the rollup into the Research stage.
- **Exit criteria:** a manual test shows a newly-published post's metrics appearing in the rollup within one scheduled refresh cycle.

## Stage 13 — Content → Prospecting Loop
- Implement the engagement-to-prospect pipeline (Part 17 / ARCHITECTURE.md §5), routing engaged accounts through the identical Discover→Score pipeline used for cold discovery.
- **Exit criteria:** a simulated reply-to-a-Metrivio-post produces a prospect record tagged `source: content_engagement` with correct evidence and score.

## Stage 14 — Full Dashboard
- Build out remaining dashboard sections (Outreach, Conversations, Content Calendar, Settings, System Health) and the Overview metrics (Part 19).
- **Exit criteria:** every metric listed in Part 19 is backed by a real query, none hardcoded/placeholder.

## Stage 15 — Reliability & Security Hardening Pass
- Chaos-test restart-mid-job for every pipeline stage; confirm no duplicate outreach, no lost evidence, no double-publish.
- Confirm credential handling: grep the codebase and logs for any secret material; confirm `audit_log.detail` never contains a token/cookie.
- Load-test daily limit enforcement (limits survive a restart mid-day).
- **Exit criteria:** written hardening report, all findings resolved or explicitly accepted with reasoning in RISK_REGISTER.md.

## Stage 16 — End-to-End Test Pass + Documentation
- Full pipeline dry-run from Discover through Analyze, using dry-run mode for anything that would touch real X accounts.
- Update RESEARCH.md/ARCHITECTURE.md/DATABASE.md/RISK_REGISTER.md with anything learned that changed the original plan.
- Document what is implemented vs. deferred.

---

## Explicit Non-Goals for This Build Plan
- No LinkedIn functionality at any stage.
- No Apollo integration at any stage.
- No bulk mass-follow/unfollow, auto-like farming, or auto-commenting growth mechanics at any stage (distinct from evidence-gated outreach automation, which is explicitly in scope — see ARCHITECTURE.md §9).

Autonomous outreach and autonomous publishing are **in scope and required deliverables** (Stage 8 / Stage 11), tested as first-class end states. They are not enabled *by default* on first boot (the system ships in `dry_run` for safety on a fresh install), but switching either subsystem to `autonomous` is a one-setting change in Settings, fully supported by the code from the stage that implements it onward — not a feature that's built and then withheld.
