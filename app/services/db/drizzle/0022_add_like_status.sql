ALTER TABLE `requests` ADD `like_status` integer;--> statement-breakpoint
ALTER TABLE `user_songs` ADD `like_status` integer DEFAULT 0 NOT NULL;