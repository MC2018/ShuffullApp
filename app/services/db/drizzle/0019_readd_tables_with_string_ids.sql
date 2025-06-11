CREATE TABLE `artists` (
	`artist_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `download_queue` (
	`download_queue_id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`priority` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `downloaded_songs` (
	`downloaded_song_id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `genre_jam` (
	`genre_jam_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`whitelists` text NOT NULL,
	`blacklists` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_session_data` (
	`user_id` text PRIMARY KEY NOT NULL,
	`actively_download` integer NOT NULL,
	`token` text NOT NULL,
	`expiration` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playlist_songs` (
	`playlist_song_id` text PRIMARY KEY NOT NULL,
	`playlist_id` text NOT NULL,
	`song_id` text NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`playlist_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `playlists` (
	`playlist_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`percent_until_replayable` real NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recently_played_songs` (
	`recently_played_song_id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`timestamp_seconds` integer,
	`last_played` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`time_request` integer NOT NULL,
	`request_type` integer NOT NULL,
	`user_id` text NOT NULL,
	`username` text,
	`user_hash` text,
	`song_id` text,
	`last_played` integer
);
--> statement-breakpoint
CREATE TABLE `song_artists` (
	`song_artist_id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`artist_id` text NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`artist_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`song_id` text PRIMARY KEY NOT NULL,
	`file_extension` text NOT NULL,
	`file_hash` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `song_tags` (
	`song_tag_id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`tag_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`tag_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_songs` (
	`user_id` text NOT NULL,
	`song_id` text NOT NULL,
	`last_played` integer NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`user_id`, `song_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `download_queue_song_id_unique` ON `download_queue` (`song_id`);--> statement-breakpoint
CREATE INDEX `idx_songs_name` ON `songs` (`name`);