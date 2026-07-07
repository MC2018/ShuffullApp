ALTER TABLE `playlists` ADD `is_exploratory` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `songs` ADD `exploratory` integer DEFAULT false NOT NULL;