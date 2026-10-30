import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
    ChangedSongKeysSchema,
    ChangedSongPageSchema,
    KeepResponseSchema,
    RetagResponse,
    SongListResponseSchema,
    UserSongKeysSchema,
    UserSongPageSchema,
} from "@/app/services/api/models";
import { failedKeeps, summarizeRetagFailures } from "@/app/services/sync-manager/syncLogic";

/**
 * The app's API parsing against what the Shuffull API actually sends. The files in tests/contracts/shuffull-api
 * are written by the API's own serializer (Shuffull's ApiContractGoldenFilesTest) and copied here by the hub's
 * scripts/sync-contract-fixtures.sh; don't edit them by hand (shuffull-workspace#5).
 *
 * Most song fields are defaulted so that an older API still parses, which also means a field the API renamed
 * would parse as its default with no error. So besides parsing, each test checks the API still sends every
 * field the schema reads.
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
});
