DROP INDEX IF EXISTS `idx_songs_name`;--> statement-breakpoint
CREATE INDEX `idx_songs_name` ON `songs` (`name`);