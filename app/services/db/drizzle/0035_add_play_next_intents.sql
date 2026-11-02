CREATE TABLE `play_next_intents` (
	`user_id` text NOT NULL,
	`external_song_id` text NOT NULL,
	`song_request_id` text,
	`title` text NOT NULL,
	`song_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `external_song_id`)
);
