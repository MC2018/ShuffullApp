CREATE TABLE `genre_jam` (
	`genre_jam_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`whitelists` text NOT NULL,
	`blacklists` text NOT NULL
);
