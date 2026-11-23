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
import { DEFAULT_FREE_FLOOR_BYTES, type AutoDownloadTier, type DownloadSource, type PendingAction } from "../../tools/autoDownloads";

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
    // Best-effort 1-10 HEAVINESS score from the producer's AI (null when unknown): one absolute scale across
    // genres. Called energy until shuffull-workspace#50.
    heaviness: integer("heaviness"),
    // Un-vetted "audition" song imported with no AI tags. Liking it enqueues a re-tag that promotes it
    // (clears this + adds tags); deleting its audition playlist purges it if never kept.
    exploratory: integer("exploratory", { mode: "boolean" }).notNull().default(false),
    // Tags came from a weaker model than the server's current strong one (server-computed on sync). Liking
    // the song enqueues the same re-tag as an exploratory promote, upgrading its tags in place.
    tagsStale: integer("tags_stale", { mode: "boolean" }).notNull().default(false),
    // Where audition mode starts the song, as a percent (0-100) of its length: the producer's guess at its best
    // part. Null = unknown, and audition mode starts at 35% (ShuffullApp#126).
    hookStartPercent: real("hook_start_percent"),
}, (table) => {
    return {
        nameIndex: index("idx_songs_name").on(table.name),
    };
});

export const downloadedSongTable = sqliteTable("downloaded_songs", {
    downloadedSongId: text("downloaded_song_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId),
    // "manual" = the user asked for it; "auto" = the auto-download rules did (ShuffullApp#225). The rules only ever
    // remove their own. Rows from before the column existed are manual.
    source: text("source").$type<DownloadSource>().notNull().default("manual"),
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
// Rows queued before shuffull-workspace#50 say `energy` instead of `heaviness`. They are sent as stored, and the
// site's UpdateSongRequest reads both names until Shuffull#69.
export interface UpdateSongMetadataPayload {
    name: string;
    bpm: number | null;
    heaviness: number | null;
    artists: string[];
    tags: SongTagEdit[];
}

// A queued re-tag's engine tier: "weak" = the budget model (an audition Keep), "strong" = full quality
// (likes, upgrades). Absent payload on a legacy row means strong. One row per song and user is maintained at
// enqueue time with STRONGER-WINS (a Like after a Keep replaces the pending weak row with a strong one, never the
// reverse).
export type RetagModel = "weak" | "strong";
export interface SongRetagPayload {
    model: RetagModel;
}

// A queued playlist delete carries the songs the playlist held when the user deleted it, so a Keep that was never
// recorded holds back only the delete that would purge its song (see playlistDeleteHold). Absent on older rows.
export interface DeletePlaylistPayload {
    songIds: string[];
}

// One finished listen, exactly as POST /api/v1/listens takes it (Shuffull's ListenItem). The row's requestId is the
// listenId, so a resend after a lost response comes back "duplicate" instead of counting twice.
export type ListenEndReason = "finished" | "skipped" | "previous" | "stopped";
export type ListenContext = "playlist" | "audition" | "genreJam" | "other";
// The longest jam name the server takes (Shuffull's GenreJam.MaxNameLength). A longer one would be refused for good.
export const GENRE_JAM_MAX_NAME_LENGTH = 100;

// A Genre Jam save, exactly as PUT /api/v1/genre-jams/{id} takes it plus the id: the whole jam, so a resend changes
// nothing and the last save to arrive wins.
export interface SaveGenreJamPayload {
    genreJamId: string;
    name: string;
    whitelists: WhitelistSetting;
    blacklists: WhitelistSetting;
    heavinessMin: number | null;
    heavinessMax: number | null;
}

// A Genre Jam delete via DELETE /api/v1/genre-jams/{id}.
export interface DeleteGenreJamPayload {
    genreJamId: string;
}

// A duplicate report, exactly as one item of POST /api/v1/song-duplicate-reports takes it (Shuffull's
// SongDuplicateReportItem). The row's requestId is the reportId, so a resend after a lost response finds the same
// report instead of adding a second one.
export type DuplicateReportKind = "duplicate" | "differentVersion";
export interface ReportDuplicatePayload {
    reportId: string;
    songId: string;
    otherSongId: string | null;
    kind: DuplicateReportKind;
    preferredSongId: string | null;
    note: string | null;
}

// Withdraws a report via DELETE /api/v1/song-duplicate-reports/{id}. Safe to resend.
export interface WithdrawDuplicateReportPayload {
    reportId: string;
}

export interface RecordListenPayload {
    listenId: string;
    songId: string;
    startedAt: string;
    endedAt: string;
    secondsListened: number;
    songDurationSeconds: number | null;
    endReason: ListenEndReason;
    context: ListenContext;
    playlistId: string | null;
    platform: string | null;
    userId: string;
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
    payload: text("payload", { mode: "json" }).$type<UpdateSongMetadataPayload | SongRetagPayload | DeletePlaylistPayload | RecordListenPayload | SaveGenreJamPayload | DeleteGenreJamPayload | ReportDuplicatePayload | WithdrawDuplicateReportPayload>()
});

// Outbox rows the app gave up sending, kept with the reason instead of deleted. A row lands here when the server
// rejected it (4xx) for longer than the retry window, or answered 200 but reported that item failed. They are the
// record that queued work did not happen, so it is never silently lost. The outbox never replays them; the one
// exception is a dead-lettered Keep holding a playlist delete, which that hold re-sends now and then.
export const deadLetterRequestTable = sqliteTable("dead_letter_requests", {
    requestId: text("request_id").primaryKey(),
    requestType: integer("request_type").notNull(),
    // Scopes the delete hold to the account that queued the row; logout does not clear this table.
    userId: text("user_id").notNull(),
    songId: text("song_id"),
    playlistId: text("playlist_id"),
    timeRequested: integer("time_request", { mode: "timestamp_ms" }).notNull(),
    deadLetteredAt: integer("dead_lettered_at", { mode: "timestamp_ms" }).notNull(),
    reason: text("reason").notNull(),
    // The whole original outbox row, so nothing about the request is lost with it. Its Dates read back as ISO strings.
    request: text("request", { mode: "json" }).$type<Omit<typeof requestTable.$inferInsert, "timeRequested"> & { timeRequested: string | Date }>().notNull(),
});

// The listen still in progress, checkpointed while it plays so it survives the app dying mid-song. A row is open:
// closing the listen deletes it and queues the finished listen in the outbox, in one transaction. A row still here
// when the app starts belongs to a run that died, and is closed as "stopped" at its last checkpoint
// (listenRecorder.recover).
export const listenTable = sqliteTable("listens", {
    listenId: text("listen_id").primaryKey(),
    userId: text("user_id").notNull(),
    songId: text("song_id").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    // Seconds of actual playback up to checkpointedAt: no pause, buffering or seek time.
    secondsListened: real("seconds_listened").notNull(),
    songDurationSeconds: real("song_duration_seconds"),
    context: text("context").$type<ListenContext>().notNull(),
    playlistId: text("playlist_id"),
    platform: text("platform"),
    checkpointedAt: integer("checkpointed_at", { mode: "timestamp_ms" }).notNull(),
});

// The server's per-song listen stats (GET /api/v1/listens/stats, ShuffullApp#115) as of the last refresh, so song
// details and the "Maybe drop this" list work offline. A cache, not data: every refresh replaces the user's rows, and
// a schema rebuild may drop it, since the next sync fetches it again. No foreign key to songs: the server keeps
// stats for songs this device doesn't have (or that were purged), and the screens join to the songs it does have.
export const listenStatTable = sqliteTable("listen_stats", {
    userId: text("user_id").notNull(),
    songId: text("song_id").notNull(),
    plays: integer("plays").notNull(),
    skips: integer("skips").notNull(),
    averageSecondsListened: real("average_seconds_listened").notNull(),
    // Null when none of the song's listens carried its length.
    completionPercent: real("completion_percent"),
    lastPlayed: integer("last_played", { mode: "timestamp_ms" }).notNull(),
    recentQuickSkips: integer("recent_quick_skips").notNull(),
    // The server's flag. The app never works it out itself: the rule lives only in the API (Shuffull's MaybeDropRule).
    maybeDrop: integer("maybe_drop", { mode: "boolean" }).notNull(),
}, (table) => {
    return {
        pk: primaryKey({
            columns: [table.userId, table.songId]
        }),
    };
});

// When each user's listen_stats rows were last replaced, and the "maybe drop" rule the server computed them with,
// so the screens can say how old the numbers are and what the flag means. Written in the same transaction as the rows.
export const listenStatsSyncTable = sqliteTable("listen_stats_syncs", {
    userId: text("user_id").primaryKey(),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
    skippedUnderSeconds: real("skipped_under_seconds").notNull(),
    quickSkips: integer("quick_skips").notNull(),
    ofLastPlays: integer("of_last_plays").notNull(),
});

export const downloadQueueTable = sqliteTable("download_queue", {
    downloadQueueId: text("download_queue_id").primaryKey(),
    songId: text("song_id").notNull().references(() => songTable.songId).unique(),
    priority: integer("priority").notNull(),
    // Same meaning as downloaded_songs.source, and carried over to it when the download lands. Auto rows queue at Low
    // priority, behind anything hand-picked, and are the only ones the free-space floor holds back.
    source: text("source").$type<DownloadSource>().notNull().default("manual"),
});

// This device's auto-download rules for one account (ShuffullApp#225, shuffull-workspace#150). Local on purpose:
// settings are per device and nothing syncs to the server. No row means the defaults, tier "off", so an install
// changes nothing until the user opts in. A user decision, so a schema rebuild keeps it (db/recovery.ts).
export const autoDownloadSettingsTable = sqliteTable("auto_download_settings", {
    userId: text("user_id").primaryKey(),
    tier: text("tier").$type<AutoDownloadTier>().notNull().default("off"),
    mixWeeks: integer("mix_weeks").notNull().default(0),
    mixUnheardOnly: integer("mix_unheard_only", { mode: "boolean" }).notNull().default(false),
    subscriptions: integer("subscriptions", { mode: "boolean" }).notNull().default(false),
    playlistIds: text("playlist_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    freeFloorBytes: integer("free_floor_bytes").notNull().default(DEFAULT_FREE_FLOOR_BYTES),
});

// Differences between the auto-download rules and this device that haven't held long enough to act on yet: one row
// per song, "add" (wanted, not here) or "remove" (an auto download no longer wanted). The reconciler acts once a row is
// AUTO_DOWNLOAD_DELAY_MS old and drops it the moment its difference goes away, which is what makes a mis-tapped like,
// dislike or delete undoable. Everything else the reconciler needs is derived, so losing this table only restarts the
// clocks.
export const autoDownloadPendingTable = sqliteTable("auto_download_pending", {
    songId: text("song_id").primaryKey(),
    action: text("action").$type<PendingAction>().notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
});

// A saved Genre Jam. Synced per user (ShuffullApp#214): saves and deletes go through the outbox, and every sync replaces
// the user's rows with the server's list, keeping any jam with a queued save or delete as it is locally.
export const genreJamTable = sqliteTable("genre_jam", {
    genreJamId: text("genre_jam_id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    whitelists: text("whitelists", { mode: "json" }).$type<WhitelistSetting>().notNull(),
    blacklists: text("blacklists", { mode: "json" }).$type<WhitelistSetting>().notNull(),
    // Heaviness band [heavinessMin, heavinessMax] (1-10); null = any. A song with unknown (null) heaviness is excluded
    // once either bound is set -- see getFilteredSong.
    // Stored as explicit min/max so moving to a fully custom range later is a trivial change.
    heavinessMin: integer("heaviness_min"),
    heavinessMax: integer("heaviness_max"),
});

// The longest note the server takes on a duplicate report (Shuffull's SongDuplicateReport.MaxNoteLength).
export const DUPLICATE_REPORT_MAX_NOTE_LENGTH = 500;

// "pending", "notDuplicate" and "keptBoth" hide the song (SONG_HIDDEN_STATUSES); "merged" and "withdrawn" are the
// server's other statuses. "rejected" is this device's own: the server refused the report, so it hides nothing.
export type DuplicateReportStatus = "pending" | "merged" | "notDuplicate" | "keptBoth" | "withdrawn" | "rejected";

// The statuses whose report hides its song from the reporter: the server's rule (Shuffull#141) plus nothing local. A
// report waiting on a curator hides, and so does one a curator answered "not a duplicate" or "keep both": the user
// still asked not to hear that copy. Merged, withdrawn, rejected and any status this build doesn't know hide nothing.
export const SONG_HIDDEN_STATUSES: readonly DuplicateReportStatus[] = ["pending", "notDuplicate", "keptBoth"];

// A kind or status as stored: one this build knows, or whatever newer one the server sent, kept as the string it is so
// it can't fail the sync. An unknown status hides nothing, and no switch over the known ones can claim to cover it.
export type StoredDuplicateReportKind = DuplicateReportKind | (string & {});
export type StoredDuplicateReportStatus = DuplicateReportStatus | (string & {});

// The user's duplicate reports (shuffull-workspace#143, ShuffullApp#219). A report hides `hiddenSongId` for its
// reporter alone, on every screen that lists or picks songs, for as long as its status is one that hides. It is the
// user's decision and its own row: written with its outbox request in one transaction, it hides the song whether or
// not the server or a curator ever answers. It is never a Dislike. Each sync upserts the rows the server changed
// since the last one (GET .../mine), except a row with a report or withdraw still queued, which keeps its local state.
export const songDuplicateReportTable = sqliteTable("song_duplicate_reports", {
    reportId: text("report_id").primaryKey(),
    userId: text("user_id").notNull(),
    songId: text("song_id").notNull(),
    otherSongId: text("other_song_id"),
    kind: text("kind").$type<StoredDuplicateReportKind>().notNull(),
    preferredSongId: text("preferred_song_id"),
    hiddenSongId: text("hidden_song_id").notNull(),
    status: text("status").$type<StoredDuplicateReportStatus>().notNull(),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    // The server's Version exactly as it was sent (microseconds), or null while the server hasn't answered.
    version: text("version"),
}, (table) => {
    return {
        hiddenIdx: index("song_duplicate_reports_hidden_idx").on(table.userId, table.hiddenSongId, table.status),
    };
});
