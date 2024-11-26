CREATE TABLE `requests` (
	`request_guid` text PRIMARY KEY NOT NULL,
	`time_request` integer NOT NULL,
	`request_type` integer NOT NULL,
	`user_id` integer NOT NULL,
	`username` text,
	`user_hash` text,
	`song_id` integer,
	`last_played` integer
);
