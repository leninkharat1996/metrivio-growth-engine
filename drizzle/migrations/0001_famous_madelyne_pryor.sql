CREATE TABLE `content_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`signal_type` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`prospect_id` text,
	`account_id` text,
	`author_username` text,
	`company_name` text,
	`topic` text,
	`pain_category` text,
	`confidence` text NOT NULL,
	`excerpt` text,
	`extraction` text,
	`engagement_likes` integer,
	`engagement_replies` integer,
	`engagement_reposts` integer,
	`engagement_bookmarks` integer,
	`engagement_views` integer,
	`relevance_score` integer,
	`published_at` text,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_signals_signal_type_idx` ON `content_signals` (`signal_type`);--> statement-breakpoint
CREATE INDEX `content_signals_prospect_idx` ON `content_signals` (`prospect_id`);--> statement-breakpoint
CREATE INDEX `content_signals_account_idx` ON `content_signals` (`account_id`);--> statement-breakpoint
CREATE INDEX `content_signals_pain_category_idx` ON `content_signals` (`pain_category`);--> statement-breakpoint
CREATE TABLE `content_tracked_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_type` text NOT NULL,
	`x_username` text NOT NULL,
	`x_user_id` text,
	`display_name` text,
	`company_name` text,
	`classification_reason` text NOT NULL,
	`classification_confidence` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`discovered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_tracked_accounts_x_username_unique` ON `content_tracked_accounts` (`x_username`);--> statement-breakpoint
CREATE INDEX `content_tracked_accounts_account_type_idx` ON `content_tracked_accounts` (`account_type`);