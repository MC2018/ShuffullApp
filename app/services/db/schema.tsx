import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core";

export const userTable = sqliteTable("users", {
    userId: integer("user_id").primaryKey(),
    username: text("username").notNull(),
    version: integer("version", { mode: "timestamp_ms" }).notNull(),
});

export const playlistTable = sqliteTable("playlists", {
    playlistId: integer("playlist_id").primaryKey(),
    userId: integer("user_id").notNull().references(() => userTable.userId),
    name: text("name").notNull(),
    currentSongId: integer("current_song_id").notNull(),
    percentUntilReplayable: real("percent_until_replayable").notNull(),
    version: integer("version", { mode: "timestamp_ms" }).notNull(),
});

export const songTable = sqliteTable("songs", {
    songId: integer("song_id").primaryKey(),
    directory: text("directory").notNull(),
    name: text("name").notNull(),
}, (table) => {
    return {
        nameIndex: index("idx_songs_name").on(table.name),
    };
});

export const playlistSongTable = sqliteTable("playlist_songs", {
    playlistSongId: integer("playlist_song_id").primaryKey(),
    playlistId: integer("playlist_id").notNull().references(() => playlistTable.playlistId),
    songId: integer("song_id").notNull().references(() => songTable.songId),
});

export const artistTable = sqliteTable("artists", {
    artistId: integer("artist_id").primaryKey(),
    name: text("name").notNull(),
});

export const songArtistTable = sqliteTable("song_artists", {
    songArtistId: integer("song_artist_id").primaryKey(),
    songId: integer("song_id").notNull().references(() => songTable.songId),
    artistId: integer("artist_id").notNull().references(() => artistTable.artistId),
});

export const tagTable = sqliteTable("tags", {
    tagId: integer("tag_id").primaryKey(),
    name: text("name").notNull(),
});

export const songTagTable = sqliteTable("song_tags", {
    songArtistId: integer("song_tag_id").primaryKey(),
    songId: integer("song_id").notNull().references(() => songTable.songId),
    tagId: integer("tag_id").notNull().references(() => tagTable.tagId),
});

export const userSongTable = sqliteTable("user_songs", {
    userId: integer("user_id").notNull().references(() => userTable.userId),
    songId: integer("song_id").notNull().references(() => songTable.songId),
    lastPlayed: integer("last_played", { "mode": "timestamp_ms" }),
    version: integer("version", { "mode": "timestamp_ms" }),
}, (table) => {
    return {
        pk: primaryKey({
            columns: [table.userId, table.songId]
        })
    };
});

export const localSessionDataTable = sqliteTable("local_session_data", {
    userId: integer("user_id").primaryKey(),
    currentPlaylistId: integer("current_playlist_id").notNull(),
    activelyDownload: integer("actively_download", { mode: "boolean" }).notNull(),
    token: text("token").notNull(),
    expiration: integer("expiration", { mode: "timestamp_ms" })
});

export const recentlyPlayedSongTable = sqliteTable("recently_played_songs", {
    recentlyPlayedSongGuid: text("recently_played_song_guid").primaryKey(),
    songId: integer("song_id").notNull().references(() => songTable.songId),
    timestampSeconds: integer("timestamp_seconds"),
    lastPlayed: integer("last_played", { mode: "timestamp_ms" }),
});