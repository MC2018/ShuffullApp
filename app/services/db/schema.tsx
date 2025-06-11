// TODO: fix all foreign keys to have indexes
import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core";
import { WhitelistSetting } from "./types";

export const userTable = sqliteTable("users", {
    userId: text("user_id").primaryKey(),
    username: text("username").notNull(),
    version: integer("version", { mode: "timestamp_ms" }).notNull(),
});

export const playlistTable = sqliteTable("playlists", {
    playlistId: text("playlist_id").primaryKey(),
    userId: text("user_id").notNull().references(() => userTable.userId),
    name: text("name").notNull(),
    percentUntilReplayable: real("percent_until_replayable").notNull(),
    version: integer("version", { mode: "timestamp_ms" }).notNull(),
});

export const songTable = sqliteTable("songs", {
    songId: text("song_id").primaryKey(),
    fileExtension: text("file_extension").notNull(),
    fileHash: text("file_hash").notNull(),
    name: text("name").notNull(),
}, (table) => {
    return {
        nameIndex: index("idx_songs_name").on(table.name),
    };
});

export const downloadedSongTable = sqliteTable("downloaded_songs", {
    downloadedSongId: text("downloaded_song_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId),
});

export const playlistSongTable = sqliteTable("playlist_songs", {
    playlistSongId: text("playlist_song_id").primaryKey(),
    playlistId: text("playlist_id").notNull().references(() => playlistTable.playlistId),
    songId: text("song_id").notNull().references(() => songTable.songId),
});

export const artistTable = sqliteTable("artists", {
    artistId: text("artist_id").primaryKey(),
    name: text("name").notNull(),
});

export const songArtistTable = sqliteTable("song_artists", {
    songArtistId: text("song_artist_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId),
    artistId: text("artist_id").notNull().references(() => artistTable.artistId),
});

export enum TagType {
    Genre = 0,
    TimePeriod = 1,
    Language = 2
};

export const tagTable = sqliteTable("tags", {
    tagId: text("tag_id").primaryKey(),
    name: text("name").notNull(),
    type: integer("type").$type<TagType>().notNull()
});

export const songTagTable = sqliteTable("song_tags", {
    songTagId: text("song_tag_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId),
    tagId: text("tag_id").notNull().references(() => tagTable.tagId),
});

export const userSongTable = sqliteTable("user_songs", {
    userId: text("user_id").notNull().references(() => userTable.userId),
    songId: text("song_id").notNull().references(() => songTable.songId),
    lastPlayed: integer("last_played", { "mode": "timestamp_ms" }).notNull(),
    version: integer("version", { "mode": "timestamp_ms" }).notNull(),
}, (table) => {
    return {
        pk: primaryKey({
            columns: [table.userId, table.songId]
        })
    };
});

export const localSessionDataTable = sqliteTable("local_session_data", {
    userId: text("user_id").primaryKey(),
    activelyDownload: integer("actively_download", { mode: "boolean" }).notNull(),
    token: text("token").notNull(),
    expiration: integer("expiration", { mode: "timestamp_ms" }).notNull()
});

export const recentlyPlayedSongTable = sqliteTable("recently_played_songs", {
    recentlyPlayedSongId: text("recently_played_song_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId),
    timestampSeconds: integer("timestamp_seconds"),
    lastPlayed: integer("last_played", { mode: "timestamp_ms" }).notNull(),
});

export const requestTable = sqliteTable("requests", {
    requestId: text("request_id").primaryKey(),
    timeRequested: integer("time_request", { mode: "timestamp_ms" }).notNull(),
    requestType: integer("request_type").notNull(),
    userId: text("user_id").notNull(),

    // Optional fields depending on the request
    username: text("username"),
    userHash: text("user_hash"),
    songId: text("song_id"),
    lastPlayed: integer("last_played", { mode: "timestamp_ms" })
});

export const downloadQueueTable = sqliteTable("download_queue", {
    downloadQueueId: text("download_queue_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId).unique(),
    priority: integer("priority").notNull(),
});

export const genreJamTable = sqliteTable("genre_jam", {
    genreJamId: text("genre_jam_id").primaryKey(),
    name: text("name").notNull(),
    whitelists: text("whitelists", { mode: "json" }).$type<WhitelistSetting>().notNull(),
    blacklists: text("blacklists", { mode: "json" }).$type<WhitelistSetting>().notNull(),
});
