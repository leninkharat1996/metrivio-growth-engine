import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema implementing DATABASE.md exactly, table for table, plus one
 * addition not itemized in DATABASE.md: `job_runs` (see bottom of this file
 * for why, and see the Stage 1 completion report for this being flagged as a
 * deviation).
 *
 * Conventions used throughout, matching DATABASE.md's stated principles:
 *  - `id` is a text UUID primary key (generated at the application layer via
 *    uuid v4, not an autoincrement integer), so IDs are stable across a
 *    dedup/merge and never leak row-count information.
 *  - Enums are modelled as `text` columns with a CHECK constraint expressed
 *    via drizzle's `.$type<...>()` for compile-time safety; SQLite has no
 *    native enum type, and DATABASE.md does not require a hard DB-level CHECK,
 *    so enforcement lives at the application/repository layer in later stages.
 *  - JSON columns store `text` and are parsed/serialized at the repository
 *    layer (SQLite has no native JSON column type via better-sqlite3).
 *  - Every table described in DATABASE.md as "historized, not overwritten" or
 *    "append-only" has no UPDATE-oriented columns beyond what's documented —
 *    enforcement that no UPDATE path exists is a Stage 4 repository-layer
 *    concern (BUILD_PLAN.md Stage 4 exit criteria), not a schema-level one in
 *    SQLite, but the schema itself provides no columns that would invite one
 *    (no `updated_at` on `evidence`, `icp_scores`, `technology_scans`, etc.).
 */

// ---------------------------------------------------------------------------
// 1. Core Prospecting Tables
// ---------------------------------------------------------------------------

export const prospects = sqliteTable(
  'prospects',
  {
    id: text('id').primaryKey(),
    xUsername: text('x_username').notNull(),
    xUserId: text('x_user_id'),
    xUrl: text('x_url'),
    displayName: text('display_name'),
    bio: text('bio'),
    companyName: text('company_name'),
    companyDomain: text('company_domain'),
    roleTitle: text('role_title'),
    location: text('location'),
    source: text('source').notNull().$type<
      'keyword_search' | 'founder_search' | 'pain_intent_search' | 'account_graph' | 'content_engagement' | 'manual'
    >(),
    sourceDetail: text('source_detail'),
    dateDiscovered: text('date_discovered').notNull(),
    lastEnrichedAt: text('last_enriched_at'),
    lastActivityAt: text('last_activity_at'),
    outreachStatus: text('outreach_status')
      .notNull()
      .default('not_started')
      .$type<
        | 'not_started'
        | 'queued'
        | 'active_sequence'
        | 'replied'
        | 'stopped_opted_out'
        | 'stopped_not_interested'
        | 'stopped_disqualified'
        | 'stopped_manual'
        | 'converted'
      >(),
    nextAction: text('next_action'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    // Primary dedup key once known (DATABASE.md §5) — x_user_id is X's own
    // immutable identifier, more stable than a handle that can change.
    xUserIdUnique: uniqueIndex('prospects_x_user_id_unique').on(t.xUserId),
    // Fallback dedup key pre-enrichment.
    xUsernameUnique: uniqueIndex('prospects_x_username_unique').on(t.xUsername),
  })
);

/** One row per discovery method that has surfaced a given person (DATABASE.md §5.3). */
export const prospectSources = sqliteTable(
  'prospect_sources',
  {
    id: text('id').primaryKey(),
    prospectId: text('prospect_id').notNull(),
    source: text('source').notNull().$type<
      'keyword_search' | 'founder_search' | 'pain_intent_search' | 'account_graph' | 'content_engagement' | 'manual'
    >(),
    sourceDetail: text('source_detail'),
    discoveredAt: text('discovered_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    prospectIdx: index('prospect_sources_prospect_idx').on(t.prospectId),
  })
);

/** The single most important table — every factual claim about a prospect, evidence-tiered, append-only. */
export const evidence = sqliteTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    prospectId: text('prospect_id').notNull(),
    evidenceType: text('evidence_type')
      .notNull()
      .$type<
        | 'revenue_signal'
        | 'paid_acquisition_signal'
        | 'technology_signal'
        | 'maturity_signal'
        | 'decision_maker_signal'
        | 'trigger_signal'
        | 'dtc_signal'
        | 'pain_signal'
        | 'company_identification'
      >(),
    signalCategory: text('signal_category').notNull(),
    evidenceTier: text('evidence_tier').notNull().$type<'CONFIRMED' | 'STRONG_EVIDENCE' | 'LIKELY' | 'UNKNOWN'>(),
    rawValue: text('raw_value'),
    sourceUrl: text('source_url'),
    capturedAt: text('captured_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    capturedBy: text('captured_by').notNull().default('system').$type<'system' | 'manual_review'>(),
  },
  (t) => ({
    prospectIdx: index('evidence_prospect_idx').on(t.prospectId),
    typeIdx: index('evidence_type_idx').on(t.evidenceType),
  })
);

export const technologyScans = sqliteTable(
  'technology_scans',
  {
    id: text('id').primaryKey(),
    prospectId: text('prospect_id'),
    companyDomain: text('company_domain').notNull(),
    scanStatus: text('scan_status').notNull().$type<'OK' | 'BLOCKED' | 'ERROR' | 'INCONCLUSIVE'>(),
    detector: text('detector').notNull().$type<'open_tech_analyzer' | 'wappalyzergo'>(),
    renderUsed: integer('render_used', { mode: 'boolean' }).notNull().default(false),
    crawlUsed: integer('crawl_used').notNull().default(0),
    rawResponse: text('raw_response'), // JSON, serialized
    scannedAt: text('scanned_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    domainIdx: index('technology_scans_domain_idx').on(t.companyDomain),
    prospectIdx: index('technology_scans_prospect_idx').on(t.prospectId),
  })
);

export const technologyDetections = sqliteTable(
  'technology_detections',
  {
    id: text('id').primaryKey(),
    scanId: text('scan_id').notNull(),
    technologyName: text('technology_name').notNull(),
    status: text('status').notNull().$type<'DETECTED' | 'NOT_DETECTED'>(),
    confidence: integer('confidence').notNull(),
    accountIds: text('account_ids'), // JSON array, serialized
    evidence: text('evidence').notNull(), // JSON array of {source,subject,match,reliability}
    inferred: integer('inferred', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    scanIdx: index('technology_detections_scan_idx').on(t.scanId),
    techNameIdx: index('technology_detections_tech_name_idx').on(t.technologyName),
  })
);

export const technologyChangeEvents = sqliteTable('technology_change_events', {
  id: text('id').primaryKey(),
  prospectId: text('prospect_id'),
  companyDomain: text('company_domain').notNull(),
  earlierScanId: text('earlier_scan_id').notNull(),
  laterScanId: text('later_scan_id').notNull(),
  technologyName: text('technology_name').notNull(),
  changeType: text('change_type').notNull().$type<'added' | 'removed' | 'version_changed'>(),
  detectedAt: text('detected_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const icpScores = sqliteTable(
  'icp_scores',
  {
    id: text('id').primaryKey(),
    prospectId: text('prospect_id').notNull(),
    score: integer('score'), // null when exclusion_triggered
    tier: text('tier').notNull().$type<'A' | 'B' | 'C' | 'Reject'>(),
    exclusionTriggered: integer('exclusion_triggered', { mode: 'boolean' }).notNull().default(false),
    exclusionReason: text('exclusion_reason'),
    factorBreakdown: text('factor_breakdown'), // JSON, serialized
    revenueDisclosureStatus: text('revenue_disclosure_status').notNull().$type<'CONFIRMED' | 'NOT_CONFIRMED' | 'UNKNOWN'>(),
    spendDisclosureStatus: text('spend_disclosure_status').notNull().$type<'CONFIRMED' | 'NOT_CONFIRMED' | 'UNKNOWN'>(),
    missingEvidence: text('missing_evidence'), // JSON array, serialized
    recommendedAction: text('recommended_action'),
    scoredAt: text('scored_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    scoringEngineVersion: text('scoring_engine_version').notNull(),
  },
  (t) => ({
    prospectIdx: index('icp_scores_prospect_idx').on(t.prospectId),
  })
);

export const painSignals = sqliteTable('pain_signals', {
  id: text('id').primaryKey(),
  prospectId: text('prospect_id').notNull(),
  signalText: text('signal_text').notNull(),
  sourceUrl: text('source_url'),
  topic: text('topic')
    .notNull()
    .$type<'CAC' | 'ROAS' | 'MER' | 'attribution' | 'budget_allocation' | 'channel_performance' | 'profitability' | 'other'>(),
  capturedAt: text('captured_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// ---------------------------------------------------------------------------
// 2. Outreach Tables
// ---------------------------------------------------------------------------

export const sequences = sqliteTable('sequences', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  steps: text('steps').notNull(), // JSON array of {step_order, day_offset, template_id, stop_conditions[]}
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
});

export const outreachMessages = sqliteTable(
  'outreach_messages',
  {
    id: text('id').primaryKey(),
    prospectId: text('prospect_id').notNull(),
    sequenceId: text('sequence_id').notNull(),
    sequenceStepOrder: integer('sequence_step_order').notNull(),
    personalizationBasis: text('personalization_basis'), // JSON, nullable
    messageContent: text('message_content').notNull(),
    channel: text('channel').notNull().$type<'dm' | 'reply'>(),
    status: text('status').notNull().$type<'queued' | 'sent' | 'failed' | 'skipped_stop_condition'>(),
    sentAt: text('sent_at'),
    errorDetail: text('error_detail'),
  },
  (t) => ({
    // Hard backstop against duplicate sends across restarts (DATABASE.md §5.4).
    dedupUnique: uniqueIndex('outreach_messages_dedup_unique').on(t.prospectId, t.sequenceId, t.sequenceStepOrder),
  })
);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  prospectId: text('prospect_id').notNull(),
  state: text('state').notNull().$type<'active' | 'stopped'>(),
  classification: text('classification')
    .notNull()
    .default('UNKNOWN')
    .$type<'POSITIVE' | 'INTERESTED' | 'QUESTION' | 'NEUTRAL' | 'NOT_INTERESTED' | 'OPT_OUT' | 'SPAM' | 'UNKNOWN'>(),
  lastMessageAt: text('last_message_at'),
  lastMessageDirection: text('last_message_direction').$type<'outbound' | 'inbound'>(),
});

export const conversationMessages = sqliteTable(
  'conversation_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    direction: text('direction').notNull().$type<'outbound' | 'inbound'>(),
    content: text('content').notNull(),
    xMessageId: text('x_message_id'),
    timestamp: text('timestamp').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    conversationIdx: index('conversation_messages_conversation_idx').on(t.conversationId),
  })
);

// ---------------------------------------------------------------------------
// 3. Content Tables
// ---------------------------------------------------------------------------

// Stage 7 addition beyond DATABASE.md, flagged here the same way Stage 1
// flagged `job_runs`: two small, genuinely new tables, not a silent
// migration. `content_ideas`/`content_drafts`/`content_performance_rollup`
// (below, unchanged) already cover "opportunity" and "draft" concepts, but
// neither can represent a single piece of *research evidence* (a specific
// ICP/competitor/expert post or web article, with its own provenance,
// engagement metrics, and extraction), nor a *tracked account identity*
// for a competitor/expert (semantically distinct from `prospects`, which
// specifically models an outreach *target* — a competitor/expert is never
// one). See RISK_REGISTER.md's Stage 7 section for the full justification.

/** FACT/OBSERVATION/INFERENCE/OPINION — Stage 7's confidence axis (distinct from `evidence.evidence_tier`'s CONFIRMED/STRONG_EVIDENCE/LIKELY/UNKNOWN, which grades verifiability of a prospect-targeting claim; this one grades how directly a content-research claim is grounded in a source). */
export const contentSignals = sqliteTable(
  'content_signals',
  {
    id: text('id').primaryKey(),
    signalType: text('signal_type').notNull().$type<'icp_post' | 'competitor_post' | 'expert_post' | 'web_research' | 'own_post' | 'own_post_engagement'>(),
    sourceType: text('source_type').notNull().$type<'x_post' | 'web_article'>(),
    sourceUrl: text('source_url'),
    /** Links back to an existing `prospects` row for an ICP-sourced signal — reuses Stage 4 identity, never duplicated (Section A). Null for competitor/expert/web signals. */
    prospectId: text('prospect_id'),
    /** Links to `content_tracked_accounts` for a competitor/expert-sourced signal. Null for ICP/web signals. */
    accountId: text('account_id'),
    authorUsername: text('author_username'),
    companyName: text('company_name'),
    topic: text('topic'), // free-text label, not the taxonomy key itself
    painCategory: text('pain_category'), // one of PAIN_TAXONOMY_CATEGORIES (packages/content) or 'other' — validated at the application layer, same convention as every other text-typed enum in this file
    confidence: text('confidence').notNull().$type<'FACT' | 'OBSERVATION' | 'INFERENCE' | 'OPINION'>(),
    /** A short, bounded excerpt for context only — never the full source text verbatim beyond what's needed to justify the extraction (Section P: research is for insight extraction, not content copying). */
    excerpt: text('excerpt'),
    /** The structured extraction this signal represents — Section B's full field list (problem/desiredOutcome/frustration/objection/misconception/question/buyingSignal/trigger/emotionalIntensity/claimSupported/etc). JSON, serialized — kept flexible so new extraction fields never require a migration. */
    extraction: text('extraction'),
    engagementLikes: integer('engagement_likes'),
    engagementReplies: integer('engagement_replies'),
    engagementReposts: integer('engagement_reposts'),
    engagementBookmarks: integer('engagement_bookmarks'),
    engagementViews: integer('engagement_views'),
    relevanceScore: integer('relevance_score'), // 0-100, deterministic — see ContentOpportunityScoring; null when insufficient evidence (never a guessed default)
    publishedAt: text('published_at'),
    capturedAt: text('captured_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    signalTypeIdx: index('content_signals_signal_type_idx').on(t.signalType),
    prospectIdx: index('content_signals_prospect_idx').on(t.prospectId),
    accountIdx: index('content_signals_account_idx').on(t.accountId),
    painCategoryIdx: index('content_signals_pain_category_idx').on(t.painCategory),
  })
);

export const contentTrackedAccounts = sqliteTable(
  'content_tracked_accounts',
  {
    id: text('id').primaryKey(),
    accountType: text('account_type').notNull().$type<'competitor' | 'expert'>(),
    xUsername: text('x_username').notNull(),
    xUserId: text('x_user_id'),
    displayName: text('display_name'),
    companyName: text('company_name'),
    /** Why this account was classified as a competitor/expert — always populated, never a bare label (Section F: "only classify... when evidence supports it"). */
    classificationReason: text('classification_reason').notNull(),
    classificationConfidence: text('classification_confidence').notNull().$type<'FACT' | 'OBSERVATION' | 'INFERENCE' | 'OPINION'>(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    discoveredAt: text('discovered_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    xUsernameUnique: uniqueIndex('content_tracked_accounts_x_username_unique').on(t.xUsername),
    accountTypeIdx: index('content_tracked_accounts_account_type_idx').on(t.accountType),
  })
);

export const contentIdeas = sqliteTable('content_ideas', {
  id: text('id').primaryKey(),
  topic: text('topic').notNull(),
  source: text('source').notNull(),
  whyItMatters: text('why_it_matters'),
  targetAudience: text('target_audience'),
  hook: text('hook'),
  angle: text('angle'),
  recommendedFormat: text('recommended_format')
    .notNull()
    .$type<'short_post' | 'thread' | 'framework' | 'checklist' | 'teardown' | 'diagnostic_question' | 'myth' | 'analysis'>(),
  pillar: text('pillar').notNull(),
  status: text('status').notNull().default('new').$type<'new' | 'drafted' | 'rejected'>(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const contentDrafts = sqliteTable('content_drafts', {
  id: text('id').primaryKey(),
  ideaId: text('idea_id').notNull(),
  hookVariants: text('hook_variants'), // JSON {a,b,c}
  chosenHook: text('chosen_hook'),
  body: text('body').notNull(),
  qualityCheckStatus: text('quality_check_status').notNull().$type<'pass' | 'flagged'>(),
  qualityCheckNotes: text('quality_check_notes'), // JSON, nullable
  approvalStatus: text('approval_status').notNull().default('pending').$type<'pending' | 'approved' | 'rejected'>(),
  approvedBy: text('approved_by'),
  xManagerPostId: text('x_manager_post_id'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const contentPerformanceRollup = sqliteTable('content_performance_rollup', {
  id: text('id').primaryKey(),
  pillar: text('pillar').notNull(),
  format: text('format').notNull(),
  avgEngagementRate: real('avg_engagement_rate'),
  bestHookStyle: text('best_hook_style'),
  bestPostingWindow: text('best_posting_window'),
  computedAt: text('computed_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// ---------------------------------------------------------------------------
// 4. Cross-Cutting Tables
// ---------------------------------------------------------------------------

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull().$type<'system' | 'human'>(),
    actionType: text('action_type').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    detail: text('detail'), // JSON — never contains credentials, cookies, or tokens (enforced at write time)
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
    timestamp: text('timestamp').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    actionTypeIdx: index('audit_log_action_type_idx').on(t.actionType),
    timestampIdx: index('audit_log_timestamp_idx').on(t.timestamp),
  })
);

export const systemConfig = sqliteTable('system_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedBy: text('updated_by').notNull().default('system'),
});

export const sessionHealth = sqliteTable(
  'session_health',
  {
    id: text('id').primaryKey(),
    accountIdentifier: text('account_identifier').notNull(),
    state: text('state').notNull().$type<'healthy' | 'degraded' | 'at_risk'>(),
    recentErrorRate: real('recent_error_rate').notNull().default(0),
    authFailureCount24h: integer('auth_failure_count_24h').notNull().default(0),
    rateLimitHeadroom: text('rate_limit_headroom'), // JSON, nullable
    timeSinceLastSuccess: integer('time_since_last_success'),
    autoDowngradeTriggered: integer('auto_downgrade_triggered', { mode: 'boolean' }).notNull().default(false),
    checkedAt: text('checked_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    accountIdx: index('session_health_account_idx').on(t.accountIdentifier),
  })
);

export const failedJobs = sqliteTable('failed_jobs', {
  id: text('id').primaryKey(),
  jobType: text('job_type').notNull(),
  payload: text('payload'), // JSON
  errorDetail: text('error_detail'),
  attemptCount: integer('attempt_count').notNull().default(0),
  status: text('status').notNull().$type<'pending_retry' | 'abandoned' | 'resolved_manually'>(),
  firstFailedAt: text('first_failed_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  lastAttemptedAt: text('last_attempted_at'),
});

/**
 * Metadata/reference only — never the raw secret value. The actual secret
 * material lives wherever the encryption-at-rest mechanism stores its
 * ciphertext (matching X-Manager's existing AES-256-GCM pattern); this table
 * only records which account/adapter a credential belongs to and a pointer
 * to its encrypted blob, per DATABASE.md §4.
 */
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  adapter: text('adapter').notNull().$type<'xactions' | 'xmanager' | 'open_tech_analyzer' | 'anthropic'>(),
  accountIdentifier: text('account_identifier'),
  encryptedBlobRef: text('encrypted_blob_ref').notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// ---------------------------------------------------------------------------
// Stage 1 addition beyond DATABASE.md: `job_runs`
// ---------------------------------------------------------------------------
// DATABASE.md documents `failed_jobs` (a queue for jobs that have already
// failed past their retry budget) but does not itemize a table for tracking
// the state of jobs that are currently running or have completed. The
// founder's Stage 1 instructions explicitly require "persistent job/run
// state so workflows can resume safely," which needs a durable record of
// in-progress work, not only of failures.
//
// This is a small, additive table consistent with DATABASE.md's own stated
// principles (append-friendly, checkpointed, audit-inspectable) and with
// ARCHITECTURE.md's reliability requirements (Part 21) — it is flagged here,
// and in the Stage 1 completion report, as a deviation from a literal reading
// of DATABASE.md, not a silent addition.
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    jobType: text('job_type').notNull(),
    status: text('status').notNull().$type<'pending' | 'running' | 'completed' | 'failed'>(),
    checkpoint: text('checkpoint'), // JSON — arbitrary resume-cursor state, opaque to this table
    attemptCount: integer('attempt_count').notNull().default(0),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    lastHeartbeatAt: text('last_heartbeat_at'),
    errorDetail: text('error_detail'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    jobTypeIdx: index('job_runs_job_type_idx').on(t.jobType),
    statusIdx: index('job_runs_status_idx').on(t.status),
  })
);
