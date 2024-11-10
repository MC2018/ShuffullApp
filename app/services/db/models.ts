import * as Schema from "./schema";

export type User = typeof Schema.userTable.$inferSelect;
export type Playlist = typeof Schema.playlistTable.$inferSelect;
export type Song = typeof Schema.songTable.$inferSelect;
export type PlaylistSong = typeof Schema.playlistSongTable.$inferSelect;
export type Artist = typeof Schema.artistTable.$inferSelect;
export type SongArtist = typeof Schema.songArtistTable.$inferSelect;
export type Tag = typeof Schema.tagTable.$inferSelect;
export type SongTag = typeof Schema.songTagTable.$inferSelect;
export type UserSong = typeof Schema.userSongTable.$inferSelect;
export type LocalSessionData = typeof Schema.localSessionDataTable.$inferSelect;
export type RecentlyPlayedSong = typeof Schema.recentlyPlayedSongTable.$inferSelect;
