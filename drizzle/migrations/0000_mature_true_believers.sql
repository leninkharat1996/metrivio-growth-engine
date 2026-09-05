CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action_type` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`detail` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`timestamp` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_action_type_idx` ON `audit_log` (`action_type`);--> statement-breakpoint
CREATE INDEX `audit_log_timestamp_idx` ON `audit_log` (`timestamp`);--> statement-breakpoint
CREATE TABLE `content_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_id` text NOT NULL,
	`hook_variants` text,
	`chosen_hook` text,
	`body` text NOT NULL,
	`quality_check_status` text NOT NULL,
	`quality_check_notes` text,
	`approval_status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`x_manager_post_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`source` text NOT NULL,
	`why_it_matters` text,
	`target_audience` text,
	`hook` text,
	`angle` text,
	`recommended_format` text NOT NULL,
	`pillar` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_performance_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`pillar` text NOT NULL,
	`format` text NOT NULL,
	`avg_engagement_rate` real,
	`best_hook_style` text,
	`best_posting_window` text,
	`computed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`direction` text NOT NULL,
	`content` text NOT NULL,
	`x_message_id` text,
	`timestamp` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_conversation_idx` ON `conversation_messages` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`prospect_id` text NOT NULL,
	`state` text NOT NULL,
	`classification` text DEFAULT 'UNKNOWN' NOT NULL,
	`last_message_at` text,
	`last_message_direction` text
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter` text NOT NULL,
	`account_identifier` text,
	`encrypted_blob_ref` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`prospect_id` text NOT NULL,
	`evidence_type` text NOT NULL,
	`signal_category` text NOT NULL,
	`evidence_tier` text NOT NULL,
	`raw_value` text,
	`source_url` text,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`captured_by` text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evidence_prospect_idx` ON `evidence` (`prospect_id`);--> statement-breakpoint
CREATE INDEX `evidence_type_idx` ON `evidence` (`evidence_type`);--> statement-breakpoint
CREATE TABLE `failed_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`payload` text,
	`error_detail` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`first_failed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_attempted_at` text
);
--> statement-breakpoint
CREATE TABLE `icp_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`prospect_id` text NOT NULL,
	`score` integer,
	`tier` text NOT NULL,
	`exclusion_triggered` integer DEFAULT false NOT NULL,
	`exclusion_reason` text,
	`factor_breakdown` text,
	`revenue_disclosure_status` text NOT NULL,
	`spend_disclosure_status` text NOT NULL,
	`missing_evidence` text,
	`recommended_action` text,
	`scored_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`scoring_engine_version` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `icp_scores_prospect_idx` ON `icp_scores` (`prospect_id`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`status` text NOT NULL,
	`checkpoint` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`completed_at` text,
	`last_heartbeat_at` text,
	`error_detail` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_type_idx` ON `job_runs` (`job_type`);--> statement-breakpoint
CREATE INDEX `job_runs_status_idx` ON `job_runs` (`status`);--> statement-breakpoint
CREATE TABLE `outreach_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`prospect_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`sequence_step_order` integer NOT NULL,
	`personalization_basis` text,
	`message_content` text NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`sent_at` text,
	`error_detail` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_messages_dedup_unique` ON `outreach_messages` (`prospect_id`,`sequence_id`,`sequence_step_order`);--> statement-breakpoint
CREATE TABLE `pain_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`prospect_id` text NOT NULL,
	`signal_text` text NOT NULL,
	`source_url` text,
	`topic` text NOT NULL,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prospect_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`prospect_id` text NOT NULL,
	`source` text NOT NULL,
	`source_detail` text,
	`discovered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `prospect_sources_prospect_idx` ON `prospect_sources` (`prospect_id`);--> statement-breakpoint
CREATE TABLE `prospects` (
	`id` text PRIMARY KEY NOT NULL,
	`x_username` text NOT NULL,
	`x_user_id` text,
	`x_url` text,
	`display_name` text,
	`bio` text,
	`company_name` text,
	`company_domain` text,
	`role_title` text,
	`location` text,
	`source` text NOT NULL,
	`source_detail` text,
	`date_discovered` text NOT NULL,
	`last_enriched_at` text,
	`last_activity_at` text,
	`outreach_status` text DEFAULT 'not_started' NOT NULL,
	`next_action` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prospects_x_user_id_unique` ON `prospects` (`x_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `prospects_x_username_unique` ON `prospects` (`x_username`);--> statement-breakpoint
CREATE TABLE `sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`steps` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_health` (
	`id` text PRIMARY KEY NOT NULL,
	`account_identifier` text NOT NULL,
	`state` text NOT NULL,
	`recent_error_rate` real DEFAULT 0 NOT NULL,
	`auth_failure_count_24h` integer DEFAULT 0 NOT NULL,
	`rate_limit_headroom` text,
	`time_since_last_success` integer,
	`auto_downgrade_triggered` integer DEFAULT false NOT NULL,
	`checked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_health_account_idx` ON `session_health` (`account_identifier`);--> statement-breakpoint
CREATE TABLE `system_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_by` text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `technology_change_events` (
	`id` text PRIMARY KEY NOT NULL,
	`prospect_id` text,
	`company_domain` text NOT NULL,
	`earlier_scan_id` text NOT NULL,
	`later_scan_id` text NOT NULL,
	`technology_name` text NOT NULL,
	`change_type` text NOT NULL,
	`detected_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `technology_detections` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`technology_name` text NOT NULL,
	`status` text NOT NULL,
	`confidence` integer NOT NULL,
	`account_ids` text,
	`evidence` text NOT NULL,
	`inferred` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `technology_detections_scan_idx` ON `technology_detections` (`scan_id`);--> statement-breakpoint
CREATE INDEX `technology_detections_tech_name_idx` ON `technology_detections` (`technology_name`);--> statement-breakpoint
CREATE TABLE `technology_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`prospect_id` text,
	`company_domain` text NOT NULL,
	`scan_status` text NOT NULL,
	`detector` text NOT NULL,
	`render_used` integer DEFAULT false NOT NULL,
	`crawl_used` integer DEFAULT 0 NOT NULL,
	`raw_response` text,
	`scanned_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `technology_scans_domain_idx` ON `technology_scans` (`company_domain`);--> statement-breakpoint
CREATE INDEX `technology_scans_prospect_idx` ON `technology_scans` (`prospect_id`);