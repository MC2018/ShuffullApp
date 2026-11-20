CREATE TABLE `song_duplicate_reports` (
	`report_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`song_id` text NOT NULL,
	`other_song_id` text,
	`kind` text NOT NULL,
	`preferred_song_id` text,
	`hidden_song_id` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`version` text
);
--> statement-breakpoint
CREATE INDEX `song_duplicate_reports_hidden_idx` ON `song_duplicate_reports` (`user_id`,`hidden_song_id`,`status`);