import { z } from "zod";
import { TagType } from "../db/schema";

export const UserSchema = z.object({
    userId: z.string(),
    username: z.string(),
    version: z.coerce.date()
});
export type User = z.infer<typeof UserSchema>;

export const ArtistSchema = z.object({
    artistId: z.string(),
    name: z.string()
});
export const ArtistListSchema = ArtistSchema.array();
export type Artist = z.infer<typeof ArtistSchema>;

export const SongArtistSchema = z.object({
    songArtistId: z.string(),
    songId: z.string(),
    artistId: z.string(),
    artist: ArtistSchema.nullish()
});
export const SongArtistListSchema = SongArtistSchema.array();
export type SongArtist = z.infer<typeof SongArtistSchema>;

export const TagSchema = z.object({
    tagId: z.string(),
    name: z.string(),
    type: z.preprocess(x => typeof x === "number" ? x : undefined, z.nativeEnum(TagType))
});
export const TagListSchema = TagSchema.array();
export type Tag = z.infer<typeof TagSchema>;

export const SongTagSchema = z.object({
    songTagId: z.string(),
    songId: z.string(),
    tagId: z.string(),
    tags: TagListSchema.nullish()
});
export const SongTagListSchema = SongTagSchema.array();
export type SongTag = z.infer<typeof SongTagSchema>;

export const SongSchema = z.object({
    songId: z.string(),
    fileExtension: z.string(),
    fileHash: z.string(),
    name: z.string(),
    songTags: SongTagListSchema.nullish(),
    songArtists: SongArtistListSchema.nullish()
});
export const SongListSchema = SongSchema.array();
export type Song = z.infer<typeof SongSchema>;

export const UserSongSchema = z.object({
    userId: z.string(),
    songId: z.string(),
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
    playlistSongId: z.string(),
    playlistId: z.string(),
    songId: z.string()
});
export const PlaylistSongListSchema = PlaylistSongSchema.array();

export const PlaylistSchema = z.object({
    playlistId: z.string(),
    userId: z.string(),
    name: z.string(),
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
