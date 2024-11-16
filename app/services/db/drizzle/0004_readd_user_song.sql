CREATE TABLE `user_songs` (
	`user_id` integer NOT NULL,
	`song_id` integer NOT NULL,
	`last_played` integer,
	`version` integer,
	PRIMARY KEY(`user_id`, `song_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
