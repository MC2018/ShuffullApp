CREATE TABLE `downloaded_songs` (
	`downloaded_song_id` integer PRIMARY KEY NOT NULL,
	`song_id` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
