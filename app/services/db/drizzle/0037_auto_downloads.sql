CREATE TABLE `auto_download_pending` (
	`song_id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auto_download_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`tier` text DEFAULT 'off' NOT NULL,
	`mix_weeks` integer DEFAULT 0 NOT NULL,
	`mix_unheard_only` integer DEFAULT false NOT NULL,
	`subscriptions` integer DEFAULT false NOT NULL,
	`playlist_ids` text DEFAULT '[]' NOT NULL,
	`free_floor_bytes` integer DEFAULT 5368709120 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `download_queue` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `downloaded_songs` ADD `source` text DEFAULT 'manual' NOT NULL;