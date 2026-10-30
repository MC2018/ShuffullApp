import { afterEach, describe, expect, it } from "vitest";
import axios, { AxiosHeaders, InternalAxiosRequestConfig } from "axios";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ApiClient } from "@/app/services/api/ApiClient";
import {
    AuthenticateResponseSchema,
    ChangedSongKeysSchema,
    ChangedSongPageSchema,
    CreatePlaylistResponseSchema,
    KeepResponseSchema,
    ListenStatsResponseSchema,
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
import { LikeStatus, RequestType } from "@/app/enums";
import { RecordListenPayload, UpdateSongLastPlayedRequest } from "@/app/services/db/models";
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

/**
 * What the app sends, against the request bodies the API binds (the `*-request` files and the others the Golden README
 * marks "app sends"). The API reads an unknown key as nothing, so a field renamed on either side would land as a quiet
 * null; these fail instead (shuffull-workspace#92). Requests go through the real ApiClient with axios's adapter stubbed.
 *
 * The listen log above already checks each listen's fields (finishedListen); the listens row here pins only the
 * `{ listens }` envelope and the URL ApiClient puts them under.
 */
describe("API contract: request bodies the app sends (shuffull-workspace#92)", () => {
    const originalAdapter = axios.defaults.adapter;
    afterEach(() => { axios.defaults.adapter = originalAdapter; });

    /** A client whose every call answers 200 with `data`, and the requests it sent. Set before the client is made. */
    function stubbedClient(data: unknown = {}) {
        const sent: InternalAxiosRequestConfig[] = [];
        axios.defaults.adapter = async (config) => {
            sent.push(config);
            return { data, status: 200, statusText: "OK", headers: {}, config };
        };
        return { api: new ApiClient("http://api", "t"), sent };
    }

    /** The body as sent, without its null-valued keys: the API binds an optional field left out and one sent as null alike. */
    const body = (config: InternalAxiosRequestConfig) => withoutNulls(JSON.parse(config.data));

    /** One call: the request golden its body must match, and the response golden the call needs to parse, if any. */
    interface Case {
        request: string;
        method: string;
        url: string;
        call: (api: ApiClient) => Promise<unknown>;
        response?: string;
    }

    const cases: Case[] = [
        { request: "users-authenticate-request", method: "post", url: "/api/v1/users/authenticate",
            call: api => api.userAuthenticate("listener", "hash-abc"), response: "users-authenticate" },
        { request: "users-authenticate-request", method: "post", url: "/api/v1/users",
            call: api => api.userCreate("listener", "hash-abc"), response: "users-authenticate" },
        { request: "songs-list-request", method: "post", url: "/api/v1/songs/list",
            call: api => api.songGetList(["song-full", "song-sparse"]), response: "songs-list" },
        { request: "playlists-list-request", method: "post", url: "/api/v1/playlists/list",
            call: api => api.playlistGetList(["playlist-full", "playlist-audition"]), response: "playlists-list" },
        { request: "user-songs-create", method: "put", url: "/api/v1/user-songs",
            call: api => api.userSongCreateMany(["song-full", "song-sparse"]) },
        { request: "user-songs-like", method: "post", url: "/api/v1/user-songs/song-full/like",
            call: api => api.userSongSetLikeStatus("song-full", LikeStatus.Like) },
        { request: "songs-update", method: "put", url: "/api/v1/songs/song-full", call: api => api.songUpdate("song-full", {
            name: "Everybody Wants You",
            bpm: 128,
            heaviness: 6,
            artists: ["Billy Squier"],
            tags: [{ name: "Rock", type: TagType.Genre }, { name: "1980s", type: TagType.TimePeriod }],
        }) },
        { request: "songs-keep-request", method: "post", url: "/api/v1/songs/keep",
            call: api => api.songKeep(["song-full", "song-sparse"]), response: "songs-keep" },
        { request: "songs-retag-request", method: "post", url: "/api/v1/songs/retag",
            call: api => api.songRetag([{ songId: "song-full", model: "strong" }, { songId: "song-sparse", model: "weak" }]),
            response: "songs-retag" },
        { request: "replacements-request", method: "post", url: "/api/v1/replacements",
            call: api => api.flagSongForReplacement("song-full") },
        { request: "listens-request", method: "post", url: "/api/v1/listens",
            call: api => api.listenRecord((golden("listens-request") as { listens: RecordListenPayload[] }).listens),
            response: "listens" },
    ];

    /** [FromBody] binds JSON only, and axios sets no content type for a body passed as a string, which most calls do. */
    const sentAsJson = (config: InternalAxiosRequestConfig) =>
        expect(AxiosHeaders.from(config.headers).getContentType()).toMatch(/^application\/json/);

    it.each(cases)("$request: $method $url sends the body the API binds", async ({ request, method, url, call, response }) => {
        const { api, sent } = stubbedClient(response ? golden(response) : {});

        await call(api);

        expect(sent).toHaveLength(1);
        expect([sent[0].method, sent[0].url]).toEqual([method, url]);
        sentAsJson(sent[0]);
        expect(body(sent[0])).toStrictEqual(withoutNulls(golden(request)));
    });

    it("user-songs-last-played: the outbox's rows carry the two fields the API binds", async () => {
        // SyncManager hands ApiClient the outbox rows whole, so the body also carries the row's own columns. The API
        // ignores those; what it binds must still match.
        const row = (songId: string, lastPlayed: string): UpdateSongLastPlayedRequest => ({
            requestId: `request-${songId}`,
            timeRequested: new Date(lastPlayed),
            requestType: RequestType.UpdateSongLastPlayed,
            userId: "user-1",
            songId,
            lastPlayed: new Date(lastPlayed),
        });
        const { api, sent } = stubbedClient();

        await api.userSongUpdateLastPlayed([row("song-full", "2026-10-01T12:34:56.123Z"), row("song-sparse", "2026-10-01T12:38:56.123Z")]);

        expect(sent).toHaveLength(1);
        expect([sent[0].method, sent[0].url]).toEqual(["post", "/api/v1/user-songs/last-played"]);
        sentAsJson(sent[0]);
        expect(JSON.parse(sent[0].data)).toMatchObject(golden("user-songs-last-played") as object[]);
    });
});

function withoutNulls(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(withoutNulls);
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]));
    }
    return value;
}

describe("API contract: listen stats (ShuffullApp#115)", () => {
    it("GET /listens/stats: every field read, the server's flag and rule taken as sent", () => {
        const raw = golden("listens-stats") as { maybeDropRule: object; songs: object[] };
        const { maybeDropRule, songs } = ListenStatsResponseSchema.parse(raw);

        expect(unsentFields(ListenStatsResponseSchema, raw)).toEqual([]);
        expect(unsentFields(ListenStatsResponseSchema.shape.maybeDropRule, raw.maybeDropRule)).toEqual([]);
        for (const row of raw.songs) {
            expect(unsentFields(ListenStatsResponseSchema.shape.songs.element, row)).toEqual([]);
        }
        expect(maybeDropRule).toEqual({ skippedUnderSeconds: 30, quickSkips: 3, ofLastPlays: 5 });
        expect(songs.map(x => [x.songId, x.maybeDrop, x.completionPercent])).toEqual([
            ["song-full", true, 70.5],
            ["song-sparse", false, null],
        ]);
        expect(songs[0].lastPlayed.toISOString()).toBe("2026-10-01T12:34:56.123Z");
    });
});
