CREATE TABLE `download_queue` (
	`download_queue_id` integer PRIMARY KEY NOT NULL,
	`song_id` integer NOT NULL,
	`priority` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`song_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `download_queue_song_id_unique` ON `download_queue` (`song_id`);