import { z } from "zod";
import { TagType } from "../db/schema";

export const UserSchema = z.object({
    userId: z.string(),
    username: z.string(),
    version: z.coerce.date(),
    // Curator role flag. Defaulted so older API responses that omit it still parse.
    isCurator: z.boolean().default(false)
});
export type User = z.infer<typeof UserSchema>;

// GET /api/v1/users/me wraps the user in a { user } envelope.
export const UserResponseSchema = z.object({
    user: UserSchema
});

export const TagSchema = z.object({
    tagId: z.string(),
    name: z.string(),
    type: z.preprocess(x => typeof x === "number" ? x : undefined, z.nativeEnum(TagType))
});
export const TagListSchema = TagSchema.array();
export type Tag = z.infer<typeof TagSchema>;

// GET /api/v1/tags -> { tags: [...] }
export const TagListResponseSchema = z.object({
    tags: TagListSchema
});

// The API returns songs denormalized: `artists` and `tags` are plain name strings with no IDs.
// The app re-normalizes these into its local artist/tag/join tables during sync (see SyncManager).
// `externalSongId` has no local column and is intentionally not consumed here.
const SongFields = z.object({
    songId: z.string(),
    name: z.string(),
    fileExtension: z.string(),
    fileHash: z.string(),
    externalSongId: z.string().nullish(),
    artists: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    // Lyrics + tempo. Defaulted/nullish so older API responses that omit them still parse. Field names match
    // the songTable columns, so they flow straight through updateSongs' insert.
    syncedLyrics: z.string().nullable().default(null),
    plainLyrics: z.string().nullable().default(null),
    lyricsInstrumental: z.boolean().default(false),
    lyricsSource: z.string().nullable().default(null),
    bpm: z.number().nullable().default(null),
    heaviness: z.number().nullable().default(null),
    // Un-vetted audition song imported with no AI tags. Defaulted so older API responses still parse.
    exploratory: z.boolean().default(false),
    // Tags produced by a weaker model than the server's current strong one (e.g. a Standard-tier import).
    // Treated like exploratory for promote-on-like: liking enqueues a re-tag that upgrades the tags.
    tagsStale: z.boolean().default(false),
    // Audition mode's start point, a percent of the song's length. Defaulted so an API from before Shuffull#79,
    // which doesn't send it, still parses.
    hookStartPercent: z.number().nullable().default(null)
});

// Heaviness was called `energy` until shuffull-workspace#50, and a site from before the rename sends only that.
// Read as missing, it would blank every synced score, so take `energy` when `heaviness` is absent. Remove with
// Shuffull#69.
const withLegacyHeaviness = (raw: unknown) =>
    raw !== null && typeof raw === "object" && !("heaviness" in raw) && "energy" in raw
        ? { ...raw, heaviness: raw.energy }
        : raw;

export const SongSchema = z.preprocess(withLegacyHeaviness, SongFields);
export const SongListSchema = SongSchema.array();
export type Song = z.infer<typeof SongSchema>;

// POST /api/v1/songs/list -> { songs: [...] }
export const SongListResponseSchema = z.object({
    songs: SongListSchema
});

// A song from the incremental-changes feed: the same shape plus its server-side `version`, used as the sync
// cursor and to detect a changed fileHash (e.g. a song replaced in place with better audio).
export const ChangedSongSchema = z.preprocess(withLegacyHeaviness, SongFields.extend({
    version: z.coerce.date()
}));
export type ChangedSong = z.infer<typeof ChangedSongSchema>;

// GET /api/v1/songs/changed?afterDate=...&afterId=... -> { songs: [...], endOfList }
export const ChangedSongPageSchema = z.object({
    songs: ChangedSongSchema.array(),
    endOfList: z.boolean()
});

// Each row's `version` exactly as the server wrote it, with its song id: the keyset the next page starts after
// (`afterDate` + `afterId`). Parsed apart from the rows because a Date keeps milliseconds and Version has microseconds.
export const FeedKeySchema = z.object({
    version: z.string(),
    songId: z.string()
});
export type FeedKey = z.infer<typeof FeedKeySchema>;
export const ChangedSongKeysSchema = z.object({ songs: FeedKeySchema.array() });
export const UserSongKeysSchema = z.object({ userSongs: FeedKeySchema.array() });

/** Where a feed request starts. With `afterId` the server pages by (Version, SongId); without it, `Version > afterDate`. */
export interface FeedCursor {
    afterDate: string;
    afterId?: string;
}

export const UserSongSchema = z.object({
    userId: z.string(),
    songId: z.string(),
    lastPlayed: z.coerce.date(),
    version: z.coerce.date(),
    // LikeStatus enum as an int; defaulted so older API responses that omit it still parse.
    likeStatus: z.number().default(0)
});
export const UserSongListSchema = UserSongSchema.array();
export type UserSong = z.infer<typeof UserSongSchema>;

// GET /api/v1/user-songs -> { userSongs: [...], endOfList }
export const UserSongPageSchema = z.object({
    userSongs: UserSongListSchema,
    endOfList: z.boolean()
});

export const AuthenticateResponseSchema = z.object({
    user: UserSchema,
    token: z.string(),
    expiration: z.coerce.date()
});
export type AuthenticateResponse = z.infer<typeof AuthenticateResponseSchema>;

// The API returns playlist membership as a flat list of song IDs (`songIds`); the app turns these
// into local playlist_song join rows during sync. `currentSongId` has no local column today.
export const PlaylistSchema = z.object({
    playlistId: z.string(),
    userId: z.string(),
    name: z.string(),
    currentSongId: z.string().nullish(),
    percentUntilReplayable: z.number().min(0).max(1),
    version: z.coerce.date(),
    songIds: z.array(z.string()).default([]),
    // Audition playlist: imported from an exploratory source. Defaulted so older API responses still parse.
    isExploratory: z.boolean().default(false)
});
export const PlaylistListSchema = PlaylistSchema.array();
export type Playlist = z.infer<typeof PlaylistSchema>;

// GET /api/v1/playlists and POST /api/v1/playlists/list -> { playlists: [...] }
export const PlaylistListResponseSchema = z.object({
    playlists: PlaylistListSchema
});

// PUT /api/v1/playlists?name=... -> { playlist: {...} }
export const CreatePlaylistResponseSchema = z.object({
    playlist: PlaylistSchema
});

// POST /api/v1/songs/retag-stale?limit=N -> one bounded batch of the library re-tag. Parsed rather than cast: the
// curator screen loops on `remaining`, and a renamed field would have arrived as undefined.
export const RetagStaleResponseSchema = z.object({
    enriched: z.number(),
    failed: z.number(),
    remaining: z.number(),
    strongModel: z.string().nullable(),
});
export type RetagStaleResponse = z.infer<typeof RetagStaleResponseSchema>;

// PUT /api/v1/devices/{deviceId} (Shuffull#132): the caller's row for this install, as the check-in left it.
export const UserDeviceSchema = z.object({
    deviceId: z.string(),
    name: z.string(),
    platform: z.string().nullable(),
    createdAt: z.coerce.date(),
    lastSeenAt: z.coerce.date(),
});
export type UserDevice = z.infer<typeof UserDeviceSchema>;

// POST /api/v1/songs/retag  body: { items } -> per-song outcome (targeted, multi-id). Parsed rather than cast, like the
// Keep response below. Outcome stays a string ("enriched" | "skipped" | "failed" today) so a new outcome can't fail the
// parse; only "failed" is reported (summarizeRetagFailures).
export const RetagResponseSchema = z.object({
    results: z.array(z.object({
        songId: z.string(),
        outcome: z.string(),
        error: z.string().nullish(),
    })),
});
export type RetagResponse = z.infer<typeof RetagResponseSchema>;
// POST /api/v1/songs/keep  body: { songIds } -> per-song outcome. Any signed-in user; records the Keep (clears
// the server's Exploratory) with no AI. Parsed rather than cast: a 200 with some other body (a proxy page) must
// fail the call and be retried, not read as "no song was kept". Outcome stays a string ("kept" | "failed" today)
// so a new outcome can't fail the parse; anything but "kept" counts as not kept.
export const KeepResponseSchema = z.object({
    results: z.array(z.object({
        songId: z.string(),
        outcome: z.string(),
        error: z.string().nullish(),
    })),
});
export type KeepResponse = z.infer<typeof KeepResponseSchema>;
// POST /api/v1/listens  body: { listens } -> one outcome per listen, in request order. Parsed for the same reason
// as the Keep response. Outcome stays a string ("recorded" | "duplicate" | "rejected" today); anything but recorded
// or duplicate counts as not stored (syncLogic.failedListens).
export const RecordListensResponseSchema = z.object({
    results: z.array(z.object({
        listenId: z.string(),
        outcome: z.string(),
        error: z.string().nullish(),
    })),
});
export type RecordListensResponse = z.infer<typeof RecordListensResponseSchema>;
// GET /api/v1/listens/stats -> the caller's per-song stats over every listen they logged, and the "maybe drop this"
// rule the flags were computed with (ShuffullApp#115). Every field is required: this replaces the whole local cache, so
// a body that isn't the stats (a proxy page) must fail rather than read as "no stats". Unknown fields are ignored, so
// the server can add some. The flag is the server's; the app only shows it and never re-derives it from the numbers.
export const ListenStatsResponseSchema = z.object({
    maybeDropRule: z.object({
        skippedUnderSeconds: z.number(),
        quickSkips: z.number().int(),
        ofLastPlays: z.number().int(),
    }),
    songs: z.array(z.object({
        songId: z.string(),
        plays: z.number().int(),
        skips: z.number().int(),
        averageSecondsListened: z.number(),
        completionPercent: z.number().nullable(),
        lastPlayed: z.coerce.date(),
        recentQuickSkips: z.number().int(),
        maybeDrop: z.boolean(),
    })),
});
export type ListenStatsResponse = z.infer<typeof ListenStatsResponseSchema>;
export type MaybeDropRule = ListenStatsResponse["maybeDropRule"];

// GET /api/v1/recap/{year}?timeZone= -> the caller's recap of one year, from their own listens (ShuffullApp#116;
// Shuffull's GetRecapResponse documents every field). Months, days and hours are local to timeZone. Names and genres
// are the song's current ones; a song the server no longer has comes back with a null name and no artists.
const RecapSongSchema = z.object({
    songId: z.string(),
    name: z.string().nullable(),
    artists: z.array(z.string()),
    minutes: z.number(),
    plays: z.number(),
});
export type RecapSong = z.infer<typeof RecapSongSchema>;
const RecapArtistSchema = z.object({
    artistId: z.string(),
    name: z.string(),
    minutes: z.number(),
    plays: z.number(),
});
export const RecapSchema = z.object({
    year: z.number(),
    timeZone: z.string(),
    from: z.coerce.date(),
    to: z.coerce.date(),
    // When the caller's first listen ever started (Shuffull#104). Absent from an API older than that, so optional.
    firstListen: z.coerce.date().nullish(),
    totalMinutes: z.number(),
    plays: z.number(),
    // 12 entries, January first.
    minutesByMonth: z.array(z.number()).length(12),
    // 7 rows, Sunday first, of 24 hours each, midnight first.
    heatmap: z.array(z.array(z.number()).length(24)).length(7),
    topSongsByMinutes: z.array(RecapSongSchema),
    topSongsByPlays: z.array(RecapSongSchema),
    topArtistsByMinutes: z.array(RecapArtistSchema),
    topArtistsByPlays: z.array(RecapArtistSchema),
    topGenres: z.array(z.object({ tagId: z.string(), name: z.string(), minutes: z.number() })),
    // 12 months, each with the shares of the year's top genres. A song with two genres counts towards both, so a
    // month's percents can add up to more than 100.
    genresByMonth: z.array(z.object({
        month: z.number(),
        totalMinutes: z.number(),
        genres: z.array(z.object({ tagId: z.string(), name: z.string(), minutes: z.number(), percent: z.number() })),
    })).length(12),
    auditionMinutes: z.number(),
    // Of the songs auditioned that year, how many are kept now. percent is null when nothing was auditioned.
    keepRate: z.object({ auditionedSongs: z.number(), keptSongs: z.number(), percent: z.number().nullable() }),
    // Local days as "YYYY-MM-DD", kept as strings: parsing them as dates would read them as UTC midnight.
    longestStreak: z.object({ days: z.number(), start: z.string(), end: z.string() }).nullable(),
    longestSession: z.object({ start: z.coerce.date(), end: z.coerce.date(), minutes: z.number(), plays: z.number() }).nullable(),
    biggestGrower: z.object({ song: RecapSongSchema, month: z.number(), previousMonthMinutes: z.number() }).nullable(),
    // winter (Jan, Feb and that year's Dec), spring, summer, autumn.
    songOfEachSeason: z.array(z.object({ season: z.string(), song: RecapSongSchema.nullable() })),
    mostSkipped: z.object({ song: RecapSongSchema, skips: z.number() }).nullable(),
});
export type Recap = z.infer<typeof RecapSchema>;
/** One song to re-tag and its engine tier — the wire item of POST /songs/retag {items}. */
export interface SongRetagWireItem {
    songId: string;
    model: "weak" | "strong";
}

// GET /api/v1/capabilities -> the optional features this server has set up, read from its config. A flag an older
// server doesn't send reads as false, so the feature stays hidden.
export const CapabilitiesSchema = z.object({
    songRequests: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

// GET /api/v1/song-requests/search?q=&limit= -> songs the user can request (ShuffullApp#107). inLibrary: the server
// already has it, so a request completes at once. alreadyRequested: the caller has an open request for it. songId: the
// library song, when inLibrary. inUserLibrary: the caller already has it, so it plays without a request (Shuffull#117).
// A server older than that sends neither, and every library result is requested as before.
export const SongRequestSearchResultSchema = z.object({
    externalSongId: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    album: z.string().nullable(),
    durationSeconds: z.number().nullable(),
    thumbnailUrl: z.string().nullable(),
    isExplicit: z.boolean(),
    inLibrary: z.boolean(),
    alreadyRequested: z.boolean(),
    songId: z.string().nullable().default(null),
    inUserLibrary: z.boolean().default(false),
});
export const SongRequestSearchResponseSchema = SongRequestSearchResultSchema.array();
export type SongRequestSearchResult = z.infer<typeof SongRequestSearchResultSchema>;

// One of the caller's song requests: GET /song-requests lists them newest first, and POST /song-requests and
// DELETE /song-requests/{id} each answer with the one they changed. status is a SongRequestStatus int, kept as a plain
// number so a status a newer server adds still parses (describeSongRequest shows it as unknown). songId is set once
// it is Completed.
export const SongRequestSchema = z.object({
    songRequestId: z.string(),
    externalSongId: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    durationSeconds: z.number().nullable(),
    thumbnailUrl: z.string().nullable(),
    status: z.number().int(),
    failureReason: z.string().nullable(),
    songId: z.string().nullable(),
    targetPlaylistName: z.string(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
});
export const SongRequestListSchema = SongRequestSchema.array();
export type SongRequest = z.infer<typeof SongRequestSchema>;

// GET /api/v1/songs/deleted?before= -> the caller's deleted songs, newest first (ShuffullApp#59), read from the
// server's song tombstones. artistNames and playlistName are null on songs deleted before the server recorded them.
// externalSongId is the YouTube id, when the song came from YouTube. nextBefore is null on the last page.
export const DeletedSongSchema = z.object({
    songId: z.string(),
    name: z.string(),
    artistNames: z.string().nullable(),
    externalSongId: z.string().nullable(),
    playlistName: z.string().nullable(),
    deletedAt: z.coerce.date(),
});
export const DeletedSongsPageSchema = z.object({
    songs: DeletedSongSchema.array(),
    nextBefore: z.string().nullable(),
});
export type DeletedSong = z.infer<typeof DeletedSongSchema>;
export type DeletedSongsPage = z.infer<typeof DeletedSongsPageSchema>;

/** The body of POST /api/v1/song-requests: the song's source id, plus what the user saw, for display. */
export interface CreateSongRequestPayload {
    externalSongId: string;
    title: string;
    artists: string[];
    durationSeconds: number | null;
    thumbnailUrl: string | null;
}
