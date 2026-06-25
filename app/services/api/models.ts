import { z } from "zod";
import { TagType } from "../db/schema";

export const UserSchema = z.object({
    userId: z.string(),
    username: z.string(),
    version: z.coerce.date()
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
export const SongSchema = z.object({
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
    energy: z.number().nullable().default(null)
});
export const SongListSchema = SongSchema.array();
export type Song = z.infer<typeof SongSchema>;

// POST /api/v1/songs/list -> { songs: [...] }
export const SongListResponseSchema = z.object({
    songs: SongListSchema
});

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
    songIds: z.array(z.string()).default([])
});
export const PlaylistListSchema = PlaylistSchema.array();
export type Playlist = z.infer<typeof PlaylistSchema>;

// GET /api/v1/playlists and POST /api/v1/playlists/list -> { playlists: [...] }
export const PlaylistListResponseSchema = z.object({
    playlists: PlaylistListSchema
});
