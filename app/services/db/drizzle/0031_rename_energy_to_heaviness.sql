ALTER TABLE `genre_jam` RENAME COLUMN `energy_min` TO `heaviness_min`;--> statement-breakpoint
ALTER TABLE `genre_jam` RENAME COLUMN `energy_max` TO `heaviness_max`;--> statement-breakpoint
ALTER TABLE `songs` RENAME COLUMN `energy` TO `heaviness`;