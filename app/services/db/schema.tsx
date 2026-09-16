/**
 * Foreign keys are indexed EXPLICITLY here, and they have to be: every junction table below is keyed by a
 * surrogate id (song_tag_id, playlist_song_id, …), so its automatic primary-key index is useless for the
 * lookups the app actually performs — which are all "rows for this song". SQLite does not index foreign keys
 * on its own, so without these, `WHERE st.song_id = ?` is a full table scan.
 *
 * That was measured, not assumed. getFilteredSong (the shuffle's song picker) runs those lookups as
 * correlated EXISTS subqueries — once per candidate song — so the scans multiplied out to ~2.1 seconds on a
 * ~2,300-song library, which was the entire delay between pressing Skip and the next song starting. Nothing
 * else in that path costs more than ~25ms in total. Reproduced on the same query shape and data volume:
 * 497ms unindexed vs 3.3ms indexed, a 152x difference, with the plan going from SCAN to SEARCH.
 *
 * The composite (song_id, x) indexes are deliberate: those subqueries read only those two columns, so the
 * index covers them and SQLite never touches the table. Reverse-direction indexes exist only where queries
 * actually filter that way (playlist_id and artist_id); song_tags has no standalone tag_id index because
 * tag_id is only ever used alongside song_id.
 */
import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core";
import { WhitelistSetting } from "./types";

export const userTable = sqliteTable("users", {
    userId: text("user_id").primaryKey(),
    username: text("username").notNull(),
    version: integer("version", { mode: "timestamp_ms" }).notNull(),
    // Curator role (synced from the server). Gates the in-app song-metadata edit UI. Default false.
    isCurator: integer("is_curator", { mode: "boolean" }).notNull().default(false),
});

export const playlistTable = sqliteTable("playlists", {
    playlistId: text("playlist_id").primaryKey(),
    userId: text("user_id").notNull().references(() => userTable.userId),
    name: text("name").notNull(),
    percentUntilReplayable: real("percent_until_replayable").notNull(),
    version: integer("version", { mode: "timestamp_ms" }).notNull(),
    // Audition playlist: imported from an exploratory source; deleting it purges the songs never kept.
    isExploratory: integer("is_exploratory", { mode: "boolean" }).notNull().default(false),
});

export const songTable = sqliteTable("songs", {
    songId: text("song_id").primaryKey(),
    fileExtension: text("file_extension").notNull(),
    fileHash: text("file_hash").notNull(),
    name: text("name").notNull(),
    // Lyrics + tempo from the import contract. syncedLyrics is LRC text (already trim-shifted by the producer
    // for YT-Music lyrics); the player may apply a further manual nudge. Null/false when not provided.
    syncedLyrics: text("synced_lyrics"),
    plainLyrics: text("plain_lyrics"),
    lyricsInstrumental: integer("lyrics_instrumental", { mode: "boolean" }).notNull().default(false),
    lyricsSource: text("lyrics_source"),
    bpm: integer("bpm"),
    // Best-effort 1-10 perceived intensity/drive score from the producer's AI (null when unknown).
    energy: integer("energy"),
    // Un-vetted "audition" song imported with no AI tags. Liking it enqueues a re-tag that promotes it
    // (clears this + adds tags); deleting its audition playlist purges it if never kept.
    exploratory: integer("exploratory", { mode: "boolean" }).notNull().default(false),
    // Tags came from a weaker model than the server's current strong one (server-computed on sync). Liking
    // the song enqueues the same re-tag as an exploratory promote, upgrading its tags in place.
    tagsStale: integer("tags_stale", { mode: "boolean" }).notNull().default(false),
}, (table) => {
    return {
        nameIndex: index("idx_songs_name").on(table.name),
    };
});

export const downloadedSongTable = sqliteTable("downloaded_songs", {
    downloadedSongId: text("downloaded_song_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId),
}, (table) => {
    return {
        // "is this song downloaded?" — an EXISTS probe in getFilteredSong's localOnly branch.
        songIndex: index("idx_downloaded_songs_song").on(table.songId),
    };
});

export const playlistSongTable = sqliteTable("playlist_songs", {
    playlistSongId: text("playlist_song_id").primaryKey(),
    playlistId: text("playlist_id").notNull().references(() => playlistTable.playlistId),
    songId: text("song_id").notNull().references(() => songTable.songId),
}, (table) => {
    return {
        // Covering: getFilteredSong asks "is this song in one of these playlists?" and reads nothing else.
        songPlaylistIndex: index("idx_playlist_songs_song_playlist").on(table.songId, table.playlistId),
        // The other direction — listing a playlist's songs.
        playlistIndex: index("idx_playlist_songs_playlist").on(table.playlistId),
    };
});

export const artistTable = sqliteTable("artists", {
    artistId: text("artist_id").primaryKey(),
    name: text("name").notNull(),
});

export const songArtistTable = sqliteTable("song_artists", {
    songArtistId: text("song_artist_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId),
    artistId: text("artist_id").notNull().references(() => artistTable.artistId),
}, (table) => {
    return {
        // Covering, for both the artist whitelist/blacklist EXISTS and fetchSongDetails' artist join.
        songArtistIndex: index("idx_song_artists_song_artist").on(table.songId, table.artistId),
        // The other direction — an artist's songs.
        artistIndex: index("idx_song_artists_artist").on(table.artistId),
    };
});

export enum TagType {
    Genre = 0,
    TimePeriod = 1,
    Language = 2,
    Mood = 3,
    Theme = 4
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
}, (table) => {
    return {
        // The heaviest one: getFilteredSong runs up to ten of these EXISTS probes per candidate song (genre,
        // time period, language, mood, theme — whitelisted and blacklisted). Covering, so the table is never
        // touched. No standalone tag_id index: tag_id is only ever queried alongside song_id.
        songTagIndex: index("idx_song_tags_song_tag").on(table.songId, table.tagId),
    };
});

export const userSongTable = sqliteTable("user_songs", {
    userId: text("user_id").notNull().references(() => userTable.userId),
    songId: text("song_id").notNull().references(() => songTable.songId),
    lastPlayed: integer("last_played", { "mode": "timestamp_ms" }).notNull(),
    version: integer("version", { "mode": "timestamp_ms" }).notNull(),
    // LikeStatus (Neutral/Like/Love/Dislike). Dislike = excluded from shuffle. Synced from the SITE.
    likeStatus: integer("like_status").notNull().default(0),
}, (table) => {
    return {
        pk: primaryKey({
            columns: [table.userId, table.songId]
        }),
        // The composite PK is (user_id, song_id), so it cannot serve a lookup keyed on song_id alone — which
        // is how getFilteredSong joins. Without this, SQLite rebuilt a throwaway "AUTOMATIC COVERING INDEX"
        // over user_songs on EVERY execution of that query.
        songIndex: index("idx_user_songs_song").on(table.songId),
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

// A curator's song-metadata edit, carried as a structured JSON payload on the outbox row (richer than the
// flat optional columns below). Mirrors the site's PUT /api/v1/songs/{id} body.
export interface SongTagEdit {
    name: string;
    type: TagType;
}
export interface UpdateSongMetadataPayload {
    name: string;
    bpm: number | null;
    energy: number | null;
    artists: string[];
    tags: SongTagEdit[];
}

// A queued re-tag's engine tier: "weak" = the budget model (an audition Keep), "strong" = full quality
// (likes, upgrades). Absent payload on a legacy row means strong. One row per song is maintained at
// enqueue time with STRONGER-WINS (a Like after a Keep upgrades the pending row, never the reverse).
export type RetagModel = "weak" | "strong";
export interface SongRetagPayload {
    model: RetagModel;
}

export const requestTable = sqliteTable("requests", {
    requestId: text("request_id").primaryKey(),
    timeRequested: integer("time_request", { mode: "timestamp_ms" }).notNull(),
    requestType: integer("request_type").notNull(),
    userId: text("user_id").notNull(),

    // Optional fields depending on the request
    username: text("username"),
    userHash: text("user_hash"),
    songId: text("song_id"),
    playlistId: text("playlist_id"),
    lastPlayed: integer("last_played", { mode: "timestamp_ms" }),
    likeStatus: integer("like_status"),
    // Structured payload for richer requests (a curator song edit, a re-tag's model tier). Null for the
    // simpler request types; the per-request-type models narrow it (see db/models.ts).
    payload: text("payload", { mode: "json" }).$type<UpdateSongMetadataPayload | SongRetagPayload>()
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
    // Energy band [energyMin, energyMax] (1-10); null = any. Songs with unknown energy are still included.
    // Stored as explicit min/max so moving to a fully custom range later is a trivial change.
    energyMin: integer("energy_min"),
    energyMax: integer("energy_max"),
});
