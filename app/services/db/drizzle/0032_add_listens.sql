CREATE TABLE `listens` (
	`listen_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`song_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`seconds_listened` real NOT NULL,
	`song_duration_seconds` real,
	`context` text NOT NULL,
	`playlist_id` text,
	`platform` text,
	`checkpointed_at` integer NOT NULL
);
