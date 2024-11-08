CREATE TABLE `artists` (
	`artist_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_session_data` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`current_playlist_id` integer NOT NULL,
	`actively_download` integer NOT NULL,
	`token` text NOT NULL,
	`expiration` integer,
	`host_address` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playlist_songs` (
	`playlist_song_id` integer PRIMARY KEY NOT NULL,
	`playlist_id` integer NOT NULL,
	`song_id` integer NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`playlist_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `playlists` (
	`playlist_id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`current_song_id` integer NOT NULL,
	`percent_until_replayable` real NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recently_played_songs` (
	`recently_played_song_guid` text PRIMARY KEY NOT NULL,
	`song_id` integer NOT NULL,
	`timestamp_seconds` integer,
	`last_played` integer,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `song_artists` (
	`song_artist_id` integer PRIMARY KEY NOT NULL,
	`song_id` integer NOT NULL,
	`artist_id` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`artist_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`song_id` integer PRIMARY KEY NOT NULL,
	`directory` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `song_tags` (
	`song_tag_id` integer PRIMARY KEY NOT NULL,
	`song_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`tag_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`tag_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_songs` (
	`user_song_id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`song_id` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `id` TO `user_id`;--> statement-breakpoint
ALTER TABLE `users` ADD `username` text NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `version` integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_songs_name` ON `songs` (`name`);