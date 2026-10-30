CREATE TABLE `listen_stats` (
	`user_id` text NOT NULL,
	`song_id` text NOT NULL,
	`plays` integer NOT NULL,
	`skips` integer NOT NULL,
	`average_seconds_listened` real NOT NULL,
	`completion_percent` real,
	`last_played` integer NOT NULL,
	`recent_quick_skips` integer NOT NULL,
	`maybe_drop` integer NOT NULL,
	PRIMARY KEY(`user_id`, `song_id`)
);
--> statement-breakpoint
CREATE TABLE `listen_stats_syncs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`synced_at` integer NOT NULL,
	`skipped_under_seconds` real NOT NULL,
	`quick_skips` integer NOT NULL,
	`of_last_plays` integer NOT NULL
);
