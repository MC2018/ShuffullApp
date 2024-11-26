import { z } from "zod";

export const UserSchema = z.object({
    userId: z.number().int(),
    username: z.string(),
    version: z.coerce.date()
});
export type User = z.infer<typeof UserSchema>;

export const ArtistSchema = z.object({
    artistId: z.number().int(),
    name: z.string()
});
export const ArtistListSchema = ArtistSchema.array();
export type Artist = z.infer<typeof ArtistSchema>;

export const SongArtistSchema = z.object({
    songArtistId: z.number().int(),
    songId: z.number().int(),
    artistId: z.number().int(),
    artist: ArtistSchema.nullish()
});
export const SongArtistListSchema = SongArtistSchema.array();
export type SongArtist = z.infer<typeof SongArtistSchema>;

export const TagSchema = z.object({
    tagId: z.number().int(),
    name: z.string()
});
export const TagListSchema = TagSchema.array();
export type Tag = z.infer<typeof TagSchema>;

export const SongTagSchema = z.object({
    songTagId: z.number().int(),
    songId: z.number().int(),
    tagId: z.number().int(),
    tags: TagListSchema.nullish()
});
export const SongTagListSchema = SongTagSchema.array();
export type SongTag = z.infer<typeof SongTagSchema>;

export const SongSchema = z.object({
    songId: z.number().int(),
    directory: z.string(),
    name: z.string(),
    songTags: SongTagListSchema.nullish(),
    songArtists: SongArtistListSchema.nullish()
});
export const SongListSchema = SongSchema.array();
export type Song = z.infer<typeof SongSchema>;

export const UserSongSchema = z.object({
    userId: z.number().int(),
    songId: z.number().int(),
    lastPlayed: z.coerce.date(),
    version: z.coerce.date()
});
export const UserSongListSchema = UserSongSchema.array();
export type UserSong = z.infer<typeof UserSongSchema>;

export const AuthenticateResponseSchema = z.object({
    user: UserSchema,
    token: z.string(),
    expiration: z.coerce.date()
});
export type AuthenticateResponse = z.infer<typeof AuthenticateResponseSchema>;

export const PlaylistSongSchema = z.object({
    playlistSongId: z.number().int(),
    playlistId: z.number().int(),
    songId: z.number().int()
});
export const PlaylistSongListSchema = PlaylistSongSchema.array();

export const PlaylistSchema = z.object({
    playlistId: z.number().int(),
    userId: z.number().int(),
    name: z.string(),
    currentSongId: z.number().int(),
    percentUntilReplayable: z.number().min(0).max(1),
    version: z.coerce.date(),
    playlistSongs: PlaylistSongListSchema.nullish()
});
export const PlaylistListSchema = PlaylistSchema.array();
export type Playlist = z.infer<typeof PlaylistSchema>;

export const PaginatedResponseSchema = <T extends z.ZodType>(itemSchema: T) => z.object({
    items: z.array(itemSchema),
    endOfList: z.boolean()
});
export function parsePaginatedResponse<T>(itemSchema: z.ZodType<T>, data: any) {
    const schema = PaginatedResponseSchema(itemSchema);
    return schema.parse(data);
}
