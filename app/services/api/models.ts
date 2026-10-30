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

// POST /api/v1/songs/retag-stale?limit=N -> one bounded batch of the library re-tag.
export interface RetagStaleResponse {
    enriched: number;
    failed: number;
    remaining: number;
    strongModel: string | null;
}

// POST /api/v1/songs/retag  body: string[] (song ids) -> per-song outcome (targeted, multi-id).
export type SongRetagOutcome = "enriched" | "skipped" | "failed";
export interface SongRetagResult {
    songId: string;
    outcome: SongRetagOutcome;
    error: string | null;
}
export interface RetagResponse {
    results: SongRetagResult[];
}
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
/** One song to re-tag and its engine tier — the wire item of POST /songs/retag {items}. */
export interface SongRetagWireItem {
    songId: string;
    model: "weak" | "strong";
}
