-- Genre Jams now sync per user (ShuffullApp#214), so each row carries its owner. Jams saved before this were never
-- uploaded and have no owner; they are dropped rather than guessed at, and the user saves them again.
DROP TABLE `genre_jam`;--> statement-breakpoint
CREATE TABLE `genre_jam` (
	`genre_jam_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`whitelists` text NOT NULL,
	`blacklists` text NOT NULL,
	`heaviness_min` integer,
	`heaviness_max` integer
);
