import { describe, it, expect } from "vitest";
import {
    UserSchema,
    UserResponseSchema,
    TagSchema,
    TagListResponseSchema,
    SongSchema,
    SongListResponseSchema,
    ChangedSongSchema,
    ChangedSongPageSchema,
    UserSongSchema,
    UserSongPageSchema,
    AuthenticateResponseSchema,
    PlaylistSchema,
    PlaylistListResponseSchema,
    CreatePlaylistResponseSchema,
} from "@/app/services/api/models";
import { TagType } from "@/app/services/db/schema";

describe("UserSchema", () => {
    it("parses a valid user and coerces version to a Date", () => {
        const parsed = UserSchema.parse({
            userId: "u1",
            username: "alice",
            version: "2024-01-02T03:04:05Z",
        });
        expect(parsed.version).toBeInstanceOf(Date);
        expect(parsed.version.toISOString()).toBe("2024-01-02T03:04:05.000Z");
    });

    it("rejects a missing required field", () => {
        expect(UserSchema.safeParse({ userId: "u1", version: "2024-01-01" }).success).toBe(false);
    });

    it("UserResponseSchema unwraps the { user } envelope", () => {
        const r = UserResponseSchema.parse({ user: { userId: "u", username: "n", version: "2024-01-01" } });
        expect(r.user.userId).toBe("u");
    });
});

describe("TagSchema", () => {
    it("accepts a numeric enum type", () => {
        const t = TagSchema.parse({ tagId: "t1", name: "Rock", type: TagType.Genre });
        expect(t.type).toBe(TagType.Genre);
    });

    it("coerces a non-numeric type to undefined (which then rejects)", () => {
        // The preprocess maps non-numbers to undefined; nativeEnum rejects undefined.
        expect(TagSchema.safeParse({ tagId: "t1", name: "Rock", type: "Genre" }).success).toBe(false);
    });

    it("TagListResponseSchema parses a { tags: [...] } payload", () => {
        const r = TagListResponseSchema.parse({ tags: [{ tagId: "t", name: "n", type: 0 }] });
        expect(r.tags).toHaveLength(1);
    });
});

describe("SongSchema", () => {
    const minimal = { songId: "s1", name: "Song", fileExtension: "mp3", fileHash: "abc" };

    it("applies defaults for omitted optional fields", () => {
        const s = SongSchema.parse(minimal);
        expect(s.artists).toEqual([]);
        expect(s.tags).toEqual([]);
        expect(s.syncedLyrics).toBeNull();
        expect(s.plainLyrics).toBeNull();
        expect(s.lyricsInstrumental).toBe(false);
        expect(s.lyricsSource).toBeNull();
        expect(s.bpm).toBeNull();
        expect(s.energy).toBeNull();
    });

    it("accepts a fully populated song", () => {
        const s = SongSchema.parse({
            ...minimal,
            externalSongId: "ext",
            artists: ["A", "B"],
            tags: ["Rock"],
            syncedLyrics: "[00:01.00]x",
            plainLyrics: "x",
            lyricsInstrumental: true,
            lyricsSource: "LRCLIB",
            bpm: 120,
            energy: 7,
        });
        expect(s.artists).toEqual(["A", "B"]);
        expect(s.bpm).toBe(120);
        expect(s.lyricsInstrumental).toBe(true);
    });

    it("allows externalSongId to be null/undefined (nullish)", () => {
        expect(SongSchema.parse({ ...minimal, externalSongId: null }).externalSongId).toBeNull();
        expect(SongSchema.parse(minimal).externalSongId).toBeUndefined();
    });

    it("allows nullable lyric/tempo fields to be explicitly null", () => {
        const s = SongSchema.parse({ ...minimal, syncedLyrics: null, bpm: null, energy: null });
        expect(s.syncedLyrics).toBeNull();
        expect(s.bpm).toBeNull();
    });

    it("rejects when a required field is missing", () => {
        expect(SongSchema.safeParse({ songId: "s1", name: "x", fileExtension: "mp3" }).success).toBe(false);
    });

    it("rejects a wrong-typed field", () => {
        expect(SongSchema.safeParse({ ...minimal, bpm: "fast" }).success).toBe(false);
        expect(SongSchema.safeParse({ ...minimal, artists: "A" }).success).toBe(false);
    });

    it("SongListResponseSchema parses a { songs: [...] } payload", () => {
        const r = SongListResponseSchema.parse({ songs: [minimal] });
        expect(r.songs[0].songId).toBe("s1");
    });
});

describe("ChangedSongSchema / ChangedSongPageSchema", () => {
    const minimal = { songId: "s1", name: "Song", fileExtension: "mp3", fileHash: "abc" };

    it("extends SongSchema with a coerced version date", () => {
        const c = ChangedSongSchema.parse({ ...minimal, version: "2024-05-05T00:00:00Z" });
        expect(c.version).toBeInstanceOf(Date);
        expect(c.tags).toEqual([]); // inherited default
    });

    it("rejects a changed song without version", () => {
        expect(ChangedSongSchema.safeParse(minimal).success).toBe(false);
    });

    it("parses a paginated page with endOfList", () => {
        const page = ChangedSongPageSchema.parse({
            songs: [{ ...minimal, version: "2024-01-01" }],
            endOfList: true,
        });
        expect(page.endOfList).toBe(true);
        expect(page.songs).toHaveLength(1);
    });

    it("rejects a page missing endOfList", () => {
        expect(ChangedSongPageSchema.safeParse({ songs: [] }).success).toBe(false);
    });
});

describe("UserSongSchema / UserSongPageSchema", () => {
    const valid = {
        userId: "u1",
        songId: "s1",
        lastPlayed: "2024-01-01T00:00:00Z",
        version: "2024-01-02T00:00:00Z",
    };

    it("defaults likeStatus to 0 and coerces dates", () => {
        const us = UserSongSchema.parse(valid);
        expect(us.likeStatus).toBe(0);
        expect(us.lastPlayed).toBeInstanceOf(Date);
        expect(us.version).toBeInstanceOf(Date);
    });

    it("accepts an explicit likeStatus", () => {
        expect(UserSongSchema.parse({ ...valid, likeStatus: 3 }).likeStatus).toBe(3);
    });

    it("parses a paginated page", () => {
        const page = UserSongPageSchema.parse({ userSongs: [valid], endOfList: false });
        expect(page.endOfList).toBe(false);
        expect(page.userSongs[0].userId).toBe("u1");
    });
});

describe("AuthenticateResponseSchema", () => {
    it("parses user, token and coerced expiration", () => {
        const r = AuthenticateResponseSchema.parse({
            user: { userId: "u", username: "n", version: "2024-01-01" },
            token: "tok",
            expiration: "2024-06-01T00:00:00Z",
        });
        expect(r.token).toBe("tok");
        expect(r.expiration).toBeInstanceOf(Date);
    });

    it("rejects when token is missing", () => {
        const r = AuthenticateResponseSchema.safeParse({
            user: { userId: "u", username: "n", version: "2024-01-01" },
            expiration: "2024-06-01",
        });
        expect(r.success).toBe(false);
    });
});

describe("PlaylistSchema", () => {
    const valid = {
        playlistId: "p1",
        userId: "u1",
        name: "Mix",
        percentUntilReplayable: 0.5,
        version: "2024-01-01T00:00:00Z",
    };

    it("defaults songIds to [] and coerces version", () => {
        const p = PlaylistSchema.parse(valid);
        expect(p.songIds).toEqual([]);
        expect(p.version).toBeInstanceOf(Date);
        expect(p.currentSongId).toBeUndefined();
    });

    it("enforces percentUntilReplayable within [0, 1]", () => {
        expect(PlaylistSchema.safeParse({ ...valid, percentUntilReplayable: 1.5 }).success).toBe(false);
        expect(PlaylistSchema.safeParse({ ...valid, percentUntilReplayable: -0.1 }).success).toBe(false);
        expect(PlaylistSchema.parse({ ...valid, percentUntilReplayable: 0 }).percentUntilReplayable).toBe(0);
        expect(PlaylistSchema.parse({ ...valid, percentUntilReplayable: 1 }).percentUntilReplayable).toBe(1);
    });

    it("accepts a populated songIds list and nullish currentSongId", () => {
        const p = PlaylistSchema.parse({ ...valid, songIds: ["s1", "s2"], currentSongId: null });
        expect(p.songIds).toEqual(["s1", "s2"]);
        expect(p.currentSongId).toBeNull();
    });

    it("PlaylistListResponseSchema parses { playlists: [...] }", () => {
        expect(PlaylistListResponseSchema.parse({ playlists: [valid] }).playlists).toHaveLength(1);
    });

    it("CreatePlaylistResponseSchema unwraps { playlist }", () => {
        expect(CreatePlaylistResponseSchema.parse({ playlist: valid }).playlist.playlistId).toBe("p1");
    });
});
