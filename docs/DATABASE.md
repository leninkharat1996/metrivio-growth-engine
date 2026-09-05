# DATABASE.md — Metrivio X Growth Engine Schema

**Engine:** SQLite (WAL mode), Drizzle ORM, single file, backed up by copying the file.
**Principle:** every fact has a source; every action has a log entry; nothing is deleted, only superseded (soft state changes) so the audit trail stays intact.

---

## 1. Core Prospecting Tables

### `prospects`
One row per unique human, deduplicated across every discovery method (Part 8 requirement: a person found via multiple searches becomes one record).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `x_username` | text, unique, indexed | Canonical dedup key |
| `x_user_id` | text, unique, indexed | X's internal numeric ID — more stable than handle (handles can change); used as the *primary* dedup key once known, with `x_username` as a fallback for pre-enrichment records |
| `x_url` | text | |
| `display_name` | text | |
| `bio` | text | Raw, as scraped |
| `company_name` | text, nullable | |
| `company_domain` | text, nullable | |
| `role_title` | text, nullable | As stated in bio/profile, not inferred |
| `location` | text, nullable | |
| `source` | enum | `keyword_search` / `founder_search` / `pain_intent_search` / `account_graph` / `content_engagement` / `manual` |
| `source_detail` | text | The specific query, list, or engaging-post reference that surfaced this person |
| `date_discovered` | timestamp | |
| `last_enriched_at` | timestamp, nullable | |
| `last_activity_at` | timestamp, nullable | Last known X activity, for exclusion-check (Part 15: "no activity in 6+ months") |
| `outreach_status` | enum | `not_started` / `queued` / `active_sequence` / `replied` / `stopped_opted_out` / `stopped_not_interested` / `stopped_disqualified` / `stopped_manual` / `converted` |
| `next_action` | text, nullable | Free-text operator note on what happens next |
| `created_at` / `updated_at` | timestamp | |

### `evidence`
The single most important table — every factual claim about a prospect is a row here, never a column overwrite. This is what makes scoring auditable and prevents fact invention.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `prospect_id` | FK → prospects | |
| `evidence_type` | enum | `revenue_signal` / `paid_acquisition_signal` / `technology_signal` / `maturity_signal` / `decision_maker_signal` / `trigger_signal` / `dtc_signal` / `pain_signal` / `company_identification` |
| `signal_category` | text | The specific fixed-list category matched (e.g. "employee_count_band", "meta_ad_active_30d", "shopify_plus_detected") — must map to a category defined in the ICP document, enforced at the application layer |
| `evidence_tier` | enum | `CONFIRMED` / `STRONG_EVIDENCE` / `LIKELY` / `UNKNOWN` |
| `raw_value` | text | The literal scraped/observed content (a bio line, a job posting title, a Meta Ad Library snapshot description) |
| `source_url` | text | Required for anything feeding a "why now" trigger claim, per ICP §16 |
| `captured_at` | timestamp | |
| `captured_by` | enum | `system` / `manual_review` |

### `technology_scans`
One row per **scan attempt** (`TechAnalyzerAdapter.analyze()` call), separate from per-technology results — historized, not overwritten, so repeated scans show change over time and feed the `ota watch`-style trigger detection described in ARCHITECTURE.md §5.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `prospect_id` | FK → prospects, nullable | May be run against a domain before a prospect record exists |
| `company_domain` | text | |
| `scan_status` | enum | `OK` / `BLOCKED` / `ERROR` / `INCONCLUSIVE` — whether the scan itself succeeded. **A `technology_detections` row is only ever written for a scan with `scan_status = OK`** — a failed scan produces zero technology rows, not rows marked absent. |
| `detector` | enum | `open_tech_analyzer` (primary, verified — RESEARCH.md §2A) / `wappalyzergo` (fallback) — which implementation behind `TechAnalyzerAdapter` produced this scan |
| `render_used` / `crawl_used` | boolean / integer | Which optional modes were active for this scan (relevant to Meta Pixel/GTM detection reliability, per RESEARCH.md §2A.6) |
| `raw_response` | JSON | Full result object as returned by the detector, retained for audit/debugging |
| `scanned_at` | timestamp | |

### `technology_detections`
One row per technology found **within** a successful scan (`scan_status = OK` on the parent `technology_scans` row). A technology genuinely absent from a successful scan's results is a legitimate `NOT_DETECTED` row here — this table only exists at all for scans that succeeded, which is what makes `NOT_DETECTED` trustworthy rather than a disguised failure.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `scan_id` | FK → technology_scans | |
| `technology_name` | text | e.g. "Shopify", "Klaviyo", "Meta Pixel" — see RESEARCH.md §2A.7 for exactly which of Metrivio's named technologies are confirmed as distinct fingerprints (Shopify Plus specifically is **not** independently confirmed as its own fingerprint as of this research and should not be asserted as detected without direct source verification) |
| `status` | enum | `DETECTED` / `NOT_DETECTED` — never populated for a scan whose `scan_status` was not `OK` |
| `confidence` | integer | 0–100, the detector's own probabilistic-combination score, not a re-derived value |
| `account_ids` | JSON array, nullable | e.g. `["GTM-M92FB6B"]`, `["G-MFK23BV2BG"]` — specific, checkable identifiers where the detector captures them |
| `evidence` | JSON | Array of `{ source, subject, match, reliability }` — the detector's own audit trail, stored as-is |
| `inferred` | boolean | Mirrors the detector's own `inferred` flag where applicable (e.g., `inferredCompanyName`-style guesses within enrichment fields, capped at `LIKELY` evidence tier when feeding the `evidence` table) |

### `icp_scores`
One row per scoring run (a prospect can be rescored as evidence accumulates; history is kept, not overwritten).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `prospect_id` | FK → prospects | |
| `score` | integer | 0–100 |
| `tier` | enum | `A` / `B` / `C` / `Reject` |
| `exclusion_triggered` | boolean | If true, `score` is null (matches "exclusion overrides scoring, score not calculated") |
| `exclusion_reason` | text, nullable | |
| `factor_breakdown` | JSON | `{ revenue_fit: {points, tier}, paid_acquisition: {...}, maturity: {...}, decision_maker: {...}, trigger: {...}, dtc_fit: {...} }` |
| `revenue_disclosure_status` | enum | `CONFIRMED` / `NOT_CONFIRMED` / `UNKNOWN` |
| `spend_disclosure_status` | enum | `CONFIRMED` / `NOT_CONFIRMED` / `UNKNOWN` |
| `missing_evidence` | JSON array | List of factors with no usable evidence |
| `recommended_action` | text | |
| `scored_at` | timestamp | |
| `scoring_engine_version` | text | Pins which version of the deterministic scorer produced this, so a later scorer-logic change doesn't silently reinterpret old scores |

### `pain_signals`
Distinct from generic evidence because these feed personalization directly and need their own review surface.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `prospect_id` | FK → prospects | |
| `signal_text` | text | The actual post/quote text observed |
| `source_url` | text | |
| `topic` | enum | CAC / ROAS / MER / attribution / budget_allocation / channel_performance / profitability / other |
| `captured_at` | timestamp | |

### `technology_change_events`
Derived rows, computed by diffing two `technology_scans` (both `scan_status = OK`) against the same `company_domain` — the structured version of OpenTechAnalyzer's `ota watch` capability. Exists specifically to satisfy the ICP document's §16 trigger-verification rule, which requires two dated observations before a change counts as a "why now" signal.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `prospect_id` | FK → prospects, nullable | |
| `company_domain` | text | |
| `earlier_scan_id` / `later_scan_id` | FK → technology_scans | Both required — this row cannot exist without two dated, successful scans |
| `technology_name` | text | |
| `change_type` | enum | `added` / `removed` / `version_changed` |
| `detected_at` | timestamp | When the diff was computed (not when the change itself happened, which is only bounded by the two scan timestamps) |

A row here is exactly the kind of evidence the ICP document's trigger factor (§16) requires — dated, sourced (both underlying scans are stored and inspectable), and never asserted from a single observation.

---

## 2. Outreach Tables

### `sequences`
Configurable campaign templates (Part 10) — not hardcoded.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | |
| `steps` | JSON | Array of `{ step_order, day_offset, template_id, stop_conditions[] }` |
| `active` | boolean | |

### `outreach_messages`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `prospect_id` | FK → prospects | |
| `sequence_id` | FK → sequences | |
| `sequence_step_order` | integer | |
| `personalization_basis` | JSON, nullable | Which `evidence` row(s) the personalization referenced — null send is blocked unless this is non-empty or the template is explicitly evidence-free |
| `message_content` | text | |
| `channel` | enum | `dm` / `reply` |
| `status` | enum | `queued` / `sent` / `failed` / `skipped_stop_condition` |
| `sent_at` | timestamp, nullable | |
| `error_detail` | text, nullable | |
| **unique constraint** | `(prospect_id, sequence_id, sequence_step_order)` | Prevents duplicate sends across restarts (Part 21 requirement) |

### `conversations`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `prospect_id` | FK → prospects | |
| `state` | enum | `active` / `stopped` |
| `classification` | enum | `POSITIVE` / `INTERESTED` / `QUESTION` / `NEUTRAL` / `NOT_INTERESTED` / `OPT_OUT` / `SPAM` / `UNKNOWN` |
| `last_message_at` | timestamp | |
| `last_message_direction` | enum | `outbound` / `inbound` | |

### `conversation_messages`
Full message history, both directions, timestamped — the message-history requirement from Part 9.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `conversation_id` | FK → conversations | |
| `direction` | enum | `outbound` / `inbound` |
| `content` | text | |
| `x_message_id` | text, nullable | |
| `timestamp` | timestamp | |

---

## 3. Content Tables

(Largely delegated to the vendored X-Manager schema for scheduling/drafts/analytics — the tables below are Metrivio-specific additions layered on top.)

### `content_ideas`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `topic` | text | |
| `source` | text | Research origin (a search query, an engaged-prospect thread, a prior-post analytics finding) |
| `why_it_matters` | text | |
| `target_audience` | text | |
| `hook` | text | |
| `angle` | text | |
| `recommended_format` | enum | short_post / thread / framework / checklist / teardown / diagnostic_question / myth / analysis |
| `pillar` | enum | one of the 15 content pillars from the brief |
| `status` | enum | `new` / `drafted` / `rejected` |
| `created_at` | timestamp | |

### `content_drafts`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `idea_id` | FK → content_ideas | |
| `hook_variants` | JSON | `{ a, b, c }` |
| `chosen_hook` | text | |
| `body` | text | |
| `quality_check_status` | enum | `pass` / `flagged` |
| `quality_check_notes` | JSON, nullable | Which rule(s) flagged it (fabricated stat, implied case study, etc.) |
| `approval_status` | enum | `pending` / `approved` / `rejected` |
| `approved_by` | text, nullable | |
| `x_manager_post_id` | text, nullable | FK into the vendored X-Manager scheduler once scheduled |
| `created_at` / `updated_at` | timestamp | |

### `content_performance_rollup`
Materialized summary, refreshed on a schedule, feeding the Research stage (Part 16 feedback loop).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `pillar` | text | |
| `format` | text | |
| `avg_engagement_rate` | float | |
| `best_hook_style` | text | |
| `best_posting_window` | text | |
| `computed_at` | timestamp | |

---

## 4. Cross-Cutting Tables

### `audit_log`
Every write action anywhere in the system, both subsystems, one table.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `actor` | enum | `system` / `human` |
| `action_type` | text | e.g. `outreach.dm.sent`, `content.post.published`, `prospect.score.computed`, `config.kill_switch.toggled` |
| `entity_type` / `entity_id` | text | What was acted on |
| `detail` | JSON | Action-specific payload — **never contains credentials, cookies, or tokens** |
| `dry_run` | boolean | Whether this was a simulated (dry-run) action |
| `timestamp` | timestamp | |

### `system_config`
Key/value table backing Part 20's automation controls. Every key below is editable at runtime through Settings — none require a redeploy.

| Column | Type | Notes |
|---|---|---|
| `key` | text PK | `prospecting.outreach.automation_mode` (`dry_run` / `approval_required` / `autonomous`), `content.publishing.automation_mode` (same three values), `kill_switch`, `daily_limit_dms`, `daily_limit_follows`, `daily_limit_posts`, `daily_limit_scrapes`, `retry_max_attempts`, `session_health_auto_downgrade`, `geography_filter` (JSON — empty by default), `vertical_inclusion_rules` (JSON array — empty by default), `vertical_exclusion_rules` (JSON array — empty by default), ... |
| `value` | text | |
| `updated_at` | timestamp | |
| `updated_by` | text | |

Note: `automation_mode` is configured **independently per subsystem** (prospecting/outreach vs. content/publishing) — a founder can, for example, run content publishing in `approval_required` while outreach runs `autonomous`, or any other combination. Both fully support `autonomous` as a real, tested end state; `dry_run` is only the safe default on first boot, not a ceiling.

### `session_health`
Backs the Session Health Monitor (ARCHITECTURE.md §3.5) — one row per health-check snapshot, historized rather than overwritten so account-health trends are reviewable.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_identifier` | text | Which connected X account/session this reading is for |
| `state` | enum | `healthy` / `degraded` / `at_risk` |
| `recent_error_rate` | float | |
| `auth_failure_count_24h` | integer | |
| `rate_limit_headroom` | JSON, nullable | Raw headroom figures where the adapter exposes them |
| `time_since_last_success` | integer | Seconds |
| `auto_downgrade_triggered` | boolean | Whether this reading caused an automatic mode downgrade |
| `checked_at` | timestamp | |

### `failed_jobs`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `job_type` | text | |
| `payload` | JSON | |
| `error_detail` | text | |
| `attempt_count` | integer | |
| `status` | enum | `pending_retry` / `abandoned` / `resolved_manually` |
| `first_failed_at` / `last_attempted_at` | timestamp | |

### `credentials`
Never stores raw secrets in this table's own columns in plaintext — this table stores references/metadata only (which account, which adapter, encrypted-blob pointer), with the actual secret material handled by the same AES-256-GCM-at-rest mechanism X-Manager already implements, via environment-variable-sourced encryption keys. No credential value is ever written to `audit_log.detail`.

---

## 5. Deduplication Strategy (Part 8)

1. Primary key for a person: `x_user_id` once known (immutable, X-assigned).
2. Fallback key pre-enrichment: normalized lowercase `x_username`.
3. On every discovery hit, the pipeline first checks `prospects` by `x_user_id`, then by `x_username`; if found, it **updates `source`/`source_detail` history** (a small `prospect_sources` join table, one row per discovery method that has surfaced this person) rather than creating a new record, and appends new evidence rows rather than overwriting old ones.
4. `outreach_messages`' unique constraint on `(prospect_id, sequence_id, sequence_step_order)` is the hard backstop against duplicate sends after a crash/restart, independent of the dedup logic above.

---

## 6. Backup & Recovery

- Single SQLite file (WAL mode) — backup is `cp` of the file (plus WAL/SHM siblings) on a schedule, matching X-Manager's own documented approach.
- `failed_jobs` plus the append-only nature of `evidence`, `icp_scores`, and `audit_log` mean a restart never loses evidence history or requires re-scraping to reconstruct state — this satisfies Part 21's "recovery after restart" requirement without a separate event-sourcing system.
