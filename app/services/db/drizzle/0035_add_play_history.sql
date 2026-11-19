CREATE TABLE `play_history` (
	`listen_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`song_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`seconds_listened` real NOT NULL,
	`song_duration_seconds` real,
	`end_reason` text NOT NULL,
	`context` text NOT NULL,
	`playlist_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_play_history_user_started` ON `play_history` (`user_id`,`started_at`);