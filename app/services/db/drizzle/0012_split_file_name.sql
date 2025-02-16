ALTER TABLE `songs` ADD `file_extension` text NOT NULL;--> statement-breakpoint
ALTER TABLE `songs` ADD `file_hash` text NOT NULL;--> statement-breakpoint
ALTER TABLE `songs` DROP COLUMN `directory`;