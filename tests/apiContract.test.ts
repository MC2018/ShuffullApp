import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
    AuthenticateResponseSchema,
    ChangedSongKeysSchema,
    ChangedSongPageSchema,
    CreatePlaylistResponseSchema,
    KeepResponseSchema,
    PlaylistListResponseSchema,
    PlaylistSchema,
    RecordListensResponseSchema,
    RetagResponse,
    RetagStaleResponse,
    SongListResponseSchema,
    TagListResponseSchema,
    TagSchema,
    UserResponseSchema,
    UserSchema,
    UserSongKeysSchema,
    UserSongPageSchema,
} from "@/app/services/api/models";
import { TagType } from "@/app/services/db/schema";
import { failedKeeps, failedListens, summarizeRetagFailures } from "@/app/services/sync-manager/syncLogic";
import { finishedListen } from "@/app/tools/listens";

/**
 * The app's API parsing against what the Shuffull API actually sends. The files in tests/contracts/shuffull-api
 * are written by the API's own serializer (Shuffull's ApiContractGoldenFilesTest) and copied here by the hub's
 * scripts/sync-contract-fixtures.sh; don't edit them by hand (shuffull-workspace#5).
 *
 * Several response fields are defaulted so that an older API still parses, which also means a field the API renamed
 * would parse as its default with no error. So besides parsing, each test checks the API still sends every field the
 * schema reads.
 */
const golden = (name: string): unknown =>
    JSON.parse(readFileSync(path.resolve(__dirname, "contracts/shuffull-api", `${name}.json`), "utf8"));

/** The fields a row schema reads that the API's row doesn't send. */
function unsentFields(schema: z.AnyZodObject | z.ZodEffects<z.AnyZodObject, unknown, unknown>, row: object): string[] {
    const inner = schema instanceof z.ZodEffects ? schema.innerType() : schema;
    return Object.keys(inner.shape).filter(k => !(k in row));
}

describe("API contract: songs (shuffull-workspace#5)", () => {
    it("POST /songs/list parses with every field the app stores", () => {
        const raw = golden("songs-list") as { songs: object[] };
        const { songs } = SongListResponseSchema.parse(raw);

        expect(unsentFields(SongListResponseSchema.shape.songs.element, raw.songs[0])).toEqual([]);
        expect(songs[0]).toMatchObject({
            songId: "song-full",
            name: "Everybody Wants You",
            fileExtension: ".mp3",
            fileHash: "0f343b0931126a20f133d67c2b018a3b",
            externalSongId: "dQw4w9WgXcQ",
            artists: ["Billy Squier", "Beyoncé"],
            tags: ["Rock", "1980s", "English"],
            syncedLyrics: "[00:01.00] First line",
            plainLyrics: "First line",
            lyricsInstrumental: false,
            lyricsSource: "lrclib",
            bpm: 128,
            heaviness: 6,
            exploratory: false,
            tagsStale: true,
            hookStartPercent: 37.5,
        });
        expect(songs[1]).toMatchObject({
            songId: "song-sparse",
            externalSongId: null,
            artists: [],
            syncedLyrics: null,
            bpm: null,
            heaviness: null,
            exploratory: true,
            tagsStale: false,
            hookStartPercent: null,
        });
    });

    it("GET /songs/changed parses, and its cursor keeps the server's microseconds", () => {
        const raw = golden("songs-changed") as { songs: object[] };
        const page = ChangedSongPageSchema.parse(raw);
        const keys = ChangedSongKeysSchema.parse(raw);

        expect(unsentFields(ChangedSongPageSchema.shape.songs.element, raw.songs[0])).toEqual([]);
        expect(page.endOfList).toBe(false);
        expect(page.songs[0].version.toISOString()).toBe("2026-10-01T12:34:56.123Z");
        expect(keys.songs).toEqual([
            { version: "2026-10-01T12:34:56.123456Z", songId: "song-full" },
            { version: "2026-10-02T08:00:00.000001Z", songId: "song-sparse" },
        ]);
    });
});

describe("API contract: user songs (shuffull-workspace#5)", () => {
    it("GET /user-songs parses with like status as an int, and its cursor keeps the server's microseconds", () => {
        const raw = golden("user-songs") as { userSongs: object[] };
        const page = UserSongPageSchema.parse(raw);
        const keys = UserSongKeysSchema.parse(raw);

        expect(unsentFields(UserSongPageSchema.shape.userSongs.element, raw.userSongs[0])).toEqual([]);
        expect(page.endOfList).toBe(true);
        expect(page.userSongs.map(u => [u.songId, u.likeStatus])).toEqual([["song-full", 1], ["song-sparse", 0]]);
        expect(keys.userSongs[0]).toEqual({ version: "2026-10-01T12:34:56.123456Z", songId: "song-full" });
    });
});

describe("API contract: playlists (shuffull-workspace#5)", () => {
    it.each(["playlists", "playlists-list"])("%s parses, with the song ids the app builds playlist_song rows from", name => {
        const raw = golden(name) as { playlists: object[] };
        const playlists = PlaylistListResponseSchema.parse(raw).playlists;

        expect(unsentFields(PlaylistSchema, raw.playlists[0])).toEqual([]);
        expect(playlists.map(p => [p.playlistId, p.songIds, p.isExploratory])).toEqual([
            ["playlist-full", ["song-full", "song-sparse"], false],
            ["playlist-audition", [], true],
        ]);
        expect(playlists[0]).toMatchObject({ currentSongId: "song-full", percentUntilReplayable: 0.75 });
        expect(playlists[1].currentSongId).toBeNull();
    });

    it("PUT /playlists returns the new playlist in its envelope", () => {
        const raw = golden("playlists-create") as { playlist: object };
        const { playlist } = CreatePlaylistResponseSchema.parse(raw);

        expect(unsentFields(PlaylistSchema, raw.playlist)).toEqual([]);
        expect(playlist).toMatchObject({ name: "New playlist", songIds: [], isExploratory: false });
    });
});

describe("API contract: users (shuffull-workspace#5)", () => {
    it("GET /users/me parses, with the curator flag", () => {
        const raw = golden("users-me") as { user: object };
        const { user } = UserResponseSchema.parse(raw);

        expect(unsentFields(UserSchema, raw.user)).toEqual([]);
        expect(user).toMatchObject({ userId: "user-1", username: "listener", isCurator: true });
    });

    it("POST /users/authenticate parses the session", () => {
        const raw = golden("users-authenticate") as { user: object };
        const session = AuthenticateResponseSchema.parse(raw);

        expect(unsentFields(UserSchema, raw.user)).toEqual([]);
        expect(session.token).toBe("token-abc");
        expect(session.expiration.toISOString()).toBe("2026-11-30T00:00:00.000Z");
        expect(session.user.isCurator).toBe(true);
    });
});

describe("API contract: tags (shuffull-workspace#5)", () => {
    it("GET /tags parses, with the type as the app's TagType number", () => {
        const raw = golden("tags") as { tags: object[] };
        const { tags } = TagListResponseSchema.parse(raw);

        expect(unsentFields(TagSchema, raw.tags[0])).toEqual([]);
        expect(tags.map(t => [t.tagId, t.name, t.type])).toEqual([
            ["tag-rock", "Rock", TagType.Genre],
            ["tag-1980s", "1980s", TagType.TimePeriod],
            ["tag-english", "English", TagType.Language],
        ]);
    });
});

describe("API contract: keep and retag outcomes (shuffull-workspace#5)", () => {
    it("POST /songs/keep: only the song the server reports kept counts as kept", () => {
        const { results } = KeepResponseSchema.parse(golden("songs-keep"));

        expect(failedKeeps([{ songId: "song-full" }, { songId: "song-sparse" }], results)).toEqual([
            { request: { songId: "song-sparse" }, reason: "Song is not in your library." },
        ]);
    });

    it("POST /songs/retag: outcomes are the strings the app branches on, and failures carry their reason", () => {
        // ApiClient.songRetag casts rather than parses, so the outcome strings are checked here.
        const { results } = golden("songs-retag") as RetagResponse;

        expect(results.map(r => r.outcome)).toEqual(["enriched", "skipped", "failed"]);
        expect(summarizeRetagFailures(results)).toEqual({
            songIds: ["song-sparse"],
            reasons: ["AI is not enabled; cannot enrich songs."],
        });
    });

    it("POST /songs/retag-stale sends every field of the response the app casts to", () => {
        // ApiClient.songRetagStale casts rather than parses, so a renamed field would arrive as undefined.
        const expected: RetagStaleResponse = { enriched: 3, failed: 1, remaining: 120, strongModel: "gpt-5.6-terra" };

        expect(golden("songs-retag-stale")).toStrictEqual(expected);
    });
});

describe("API contract: the listen log (ShuffullApp#57)", () => {
    it("POST /listens: recorded and duplicate are done; rejected is dead-lettered with the server's reason", () => {
        const raw = golden("listens") as { results: object[] };
        const { results } = RecordListensResponseSchema.parse(raw);

        expect(unsentFields(RecordListensResponseSchema.shape.results.element, raw.results[0])).toEqual([]);
        const queued = ["listen-full", "listen-sparse", "listen-bad"].map(requestId => ({ requestId }));
        expect(failedListens(queued, results)).toEqual([
            { request: { requestId: "listen-bad" }, reason: "endedAt is before startedAt." },
        ]);
    });

    it("the app sends exactly the fields the API binds, in the shapes it binds them", () => {
        const [full] = (golden("listens-request") as { listens: Record<string, unknown>[] }).listens;
        const sent = finishedListen({
            listenId: "listen-full",
            userId: "user-1",
            songId: "song-full",
            startedAt: new Date("2026-10-01T12:34:56.123Z"),
            songDurationSeconds: 214,
            context: "playlist",
            playlistId: "playlist-1",
            platform: "android",
        }, Date.parse("2026-10-01T12:38:30.123Z"), 201.5, "finished");

        expect(Object.keys(sent).sort()).toEqual(Object.keys(full).sort());
        // The API's sample has microseconds; JS dates carry milliseconds. Everything else is the same value.
        expect({ ...sent, startedAt: undefined, endedAt: undefined })
            .toEqual({ ...full, startedAt: undefined, endedAt: undefined });
        expect(Date.parse(sent.startedAt)).toBe(Date.parse(full.startedAt as string));
        expect(Date.parse(sent.endedAt)).toBe(Date.parse(full.endedAt as string));
    });
});
