CREATE TABLE `local_session_data` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`current_playlist_id` integer NOT NULL,
	`actively_download` integer NOT NULL,
	`token` text NOT NULL,
	`expiration` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recently_played_songs` (
	`recently_played_song_guid` text PRIMARY KEY NOT NULL,
	`song_id` integer NOT NULL,
	`timestamp_seconds` integer,
	`last_played` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_songs` (
	`user_id` integer NOT NULL,
	`song_id` integer NOT NULL,
	`last_played` integer NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`user_id`, `song_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
