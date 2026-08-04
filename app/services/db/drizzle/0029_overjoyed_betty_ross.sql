CREATE INDEX `idx_downloaded_songs_song` ON `downloaded_songs` (`song_id`);--> statement-breakpoint
CREATE INDEX `idx_playlist_songs_song_playlist` ON `playlist_songs` (`song_id`,`playlist_id`);--> statement-breakpoint
CREATE INDEX `idx_playlist_songs_playlist` ON `playlist_songs` (`playlist_id`);--> statement-breakpoint
CREATE INDEX `idx_song_artists_song_artist` ON `song_artists` (`song_id`,`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_song_artists_artist` ON `song_artists` (`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_song_tags_song_tag` ON `song_tags` (`song_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `idx_user_songs_song` ON `user_songs` (`song_id`);