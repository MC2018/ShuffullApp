CREATE TABLE `dead_letter_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`request_type` integer NOT NULL,
	`user_id` text NOT NULL,
	`song_id` text,
	`playlist_id` text,
	`time_request` integer NOT NULL,
	`dead_lettered_at` integer NOT NULL,
	`reason` text NOT NULL,
	`request` text NOT NULL
);
