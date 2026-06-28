ALTER TABLE `requests` ADD `payload` text;--> statement-breakpoint
ALTER TABLE `users` ADD `is_curator` integer DEFAULT false NOT NULL;