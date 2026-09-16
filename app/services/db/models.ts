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
export type Request = typeof Schema.requestTable.$inferInsert;
export type AuthenticateRequest = Request & {
    username: string,
    userHash: string,
};
export type CreateUserSongRequest = Request & {
    songId: string
};
export type OverallSyncRequest = Request;
export type UpdateSongLastPlayedRequest = Request & {
    songId: string,
    lastPlayed: Date
};
export type SetSongLikeStatusRequest = Request & {
    songId: string,
    likeStatus: number
};
export type FlagSongForReplacementRequest = Request & {
    songId: string
};
export type UpdateSongMetadataRequest = Request & {
    songId: string,
    payload: Schema.UpdateSongMetadataPayload
};
export type SongRetagRequest = Request & {
    songId: string,
    // Absent on legacy rows => strong. Maintained one-row-per-song with stronger-wins at enqueue time.
    payload?: Schema.SongRetagPayload | null
};
export type DeletePlaylistRequest = Request & {
    playlistId: string
};
export type UpdateSongMetadataPayload = Schema.UpdateSongMetadataPayload;
export type SongTagEdit = Schema.SongTagEdit;
export type SongRetagPayload = Schema.SongRetagPayload;
export type RetagModel = Schema.RetagModel;
export type DownloadQueue = typeof Schema.downloadQueueTable.$inferSelect;
export type DownloadedSong = typeof Schema.downloadedSongTable.$inferSelect;
export type GenreJam = typeof Schema.genreJamTable.$inferSelect;
