ALTER TABLE `songs` ADD `synced_lyrics` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `plain_lyrics` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `lyrics_instrumental` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `songs` ADD `lyrics_offset_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `songs` ADD `lyrics_source` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `bpm` integer;