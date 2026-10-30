import { describe, it, expect, afterEach } from "vitest";
import axios, { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from "axios";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { ApiClient } from "@/app/services/api/ApiClient";
import { ApiStatusFailureError, statusOfFailure } from "@/app/services/api/errors";
import { addRequests, deadLetterRequests, getDeadLetterRequests, getRequests } from "@/app/services/db/queries/request";
import { deadLetterRequestTable } from "@/app/services/db/schema";
import { failedKeeps, keepsDueForRetry, playlistDeleteHold, withoutPendingDeletes } from "@/app/services/sync-manager/syncLogic";
import { RequestType } from "@/app/enums";

describe("statusOfFailure (what the outbox acts on)", () => {
    const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;

    it("an API rejection keeps its real status", () => {
        expect(statusOfFailure(new ApiStatusFailureError("/x", { status: 403 }))).toBe(403);
    });

    it("an axios error with a response keeps that status", () => {
        const error = new AxiosError("nope", "ERR_BAD_REQUEST", config, null, {
            status: 404, statusText: "", headers: {}, config, data: null,
        });
        expect(statusOfFailure(error)).toBe(404);
    });

    it("no response at all (offline, timeout) is 503: retry everything later", () => {
        expect(statusOfFailure(new AxiosError("timeout", "ECONNABORTED", config))).toBe(503);
    });

    it("anything else is 500", () => {
        expect(statusOfFailure(new Error("bad parse"))).toBe(500);
    });
});

describe("ApiClient: a non-2xx reaches the outbox as its real status", () => {
    const originalAdapter = axios.defaults.adapter;
    afterEach(() => { axios.defaults.adapter = originalAdapter; });

    function respondWith(status: number, data: unknown, seen: InternalAxiosRequestConfig[] = []) {
        axios.defaults.adapter = async (config) => {
            seen.push(config);
            return { status, statusText: "", headers: {}, config, data };
        };
    }

    it("a 400 from /songs/keep throws ApiStatusFailureError carrying 400 and the reason", async () => {
        respondWith(400, { error: "Too many songs" });
        const error = await new ApiClient("http://api", "t").songKeep(["s1"]).catch(e => e);

        expect(error).toBeInstanceOf(ApiStatusFailureError);
        expect(statusOfFailure(error)).toBe(400);
        expect(String(error.message)).toContain("Too many songs");
    });

    it("a 401 is a 401, so sync logs out", async () => {
        respondWith(401, null);
        const error = await new ApiClient("http://api", "t").playlistDelete("p1").catch(e => e);

        expect(statusOfFailure(error)).toBe(401);
    });

    it("songKeep posts { songIds } to /api/v1/songs/keep and returns the per-song outcomes", async () => {
        const seen: InternalAxiosRequestConfig[] = [];
        respondWith(200, { results: [{ songId: "s1", outcome: "kept", error: null }] }, seen);

        const response = await new ApiClient("http://api", "t").songKeep(["s1", "s2"]);

        expect(seen[0].method).toBe("post");
        expect(seen[0].url).toBe("/api/v1/songs/keep");
        expect(JSON.parse(seen[0].data)).toEqual({ songIds: ["s1", "s2"] });
        expect(response.results[0].outcome).toBe("kept");
    });

    it("listenRecord posts { listens } to /api/v1/listens and parses the per-listen outcomes", async () => {
        const seen: InternalAxiosRequestConfig[] = [];
        respondWith(200, { results: [{ listenId: "l1", outcome: "recorded", error: null }] }, seen);
        const listen = {
            listenId: "l1", songId: "s1", startedAt: "2026-10-31T01:00:00.000Z", endedAt: "2026-10-31T01:01:00.000Z",
            secondsListened: 60, songDurationSeconds: null, endReason: "skipped" as const, context: "other" as const,
            playlistId: null, platform: "android", userId: "u1",
        };

        const response = await new ApiClient("http://api", "t").listenRecord([listen]);

        expect(seen[0].method).toBe("post");
        expect(seen[0].url).toBe("/api/v1/listens");
        expect(JSON.parse(seen[0].data)).toEqual({ listens: [listen] });
        expect(response.results[0].outcome).toBe("recorded");
    });

    it("a 400 from /listens throws carrying 400, so the outbox partitions it", async () => {
        respondWith(400, { error: "Too many listens" });
        const error = await new ApiClient("http://api", "t").listenRecord([]).catch(e => e);

        expect(statusOfFailure(error)).toBe(400);
    });
});

describe("failedKeeps (a 200 does not mean every Keep was recorded)", () => {
    it("only songs named 'kept' count; the rest come back with a reason", () => {
        const rows = [
            { requestId: "a", songId: "kept" },
            { requestId: "b", songId: "refused" },
            { requestId: "c", songId: "missing" },
            { requestId: "d", songId: null },
        ];

        const failures = failedKeeps(rows, [
            { songId: "kept", outcome: "kept" },
            { songId: "refused", outcome: "failed", error: "Song is not in your library." },
        ]);

        expect(failures.map(x => [x.request.requestId, x.reason])).toEqual([
            ["b", "Song is not in your library."],
            ["c", "The server returned no outcome for this song."],
            ["d", "Keep row has no song id."],
        ]);
    });

    it("a body with no results fails every row rather than passing them", () => {
        expect(failedKeeps([{ songId: "s1" }], undefined)).toHaveLength(1);
    });
});

describe("playlistDeleteHold", () => {
    const keep = { requestType: RequestType.SongRetag };
    const like = { requestType: RequestType.SetSongLikeStatus };
    const deadKeep = (songId: string) => ({ requestType: RequestType.SongRetag, songId });
    const deleting = (...songIds: string[]) => ({ payload: { songIds } });

    it("holds every delete while a Keep is queued", () => {
        expect(playlistDeleteHold(deleting("x"), [like, keep], [])).toMatchObject({ retrySongIds: [] });
    });

    it("a dead-lettered Keep holds only a delete whose playlist held its song, and asks to re-send it", () => {
        expect(playlistDeleteHold(deleting("a", "b"), [], [deadKeep("b"), deadKeep("c")]))
            .toMatchObject({ retrySongIds: ["b"] });
        expect(playlistDeleteHold(deleting("a"), [], [deadKeep("c")])).toBeNull();
    });

    it("an older delete with no recorded songs is held by any dead-lettered Keep", () => {
        expect(playlistDeleteHold({ payload: null }, [], [deadKeep("c")])).toMatchObject({ retrySongIds: ["c"] });
    });

    it("other queued or dead-lettered work does not hold a delete", () => {
        expect(playlistDeleteHold({}, [like], [{ ...like, songId: "a" }])).toBeNull();
    });
});

describe("keepsDueForRetry", () => {
    it("re-sends a held Keep never tried, or last tried an hour or more ago", () => {
        const now = 10 * 60 * 60 * 1000;
        const tried = new Map([["recent", now - 59 * 60 * 1000], ["stale", now - 60 * 60 * 1000]]);

        expect(keepsDueForRetry(["new", "recent", "stale"], tried, now)).toEqual(["new", "stale"]);
    });
});

describe("withoutPendingDeletes", () => {
    it("drops playlists with a queued delete, so the pull doesn't bring them back", () => {
        const playlists = [{ playlistId: "gone" }, { playlistId: "kept" }];
        const outbox = [
            { requestType: RequestType.DeletePlaylist, playlistId: "gone" },
            { requestType: RequestType.SongRetag, playlistId: "kept" },
        ];

        expect(withoutPendingDeletes(playlists, outbox)).toEqual([{ playlistId: "kept" }]);
    });
});

describe("deadLetterRequests", () => {
    function makeDb(): GenericDb {
        const db = drizzle(new Database(":memory:"));
        migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
        return db as unknown as GenericDb;
    }

    const row = {
        requestId: "r1",
        timeRequested: new Date("2026-10-01T00:00:00Z"),
        requestType: RequestType.SongRetag,
        userId: "u1",
        songId: "s1",
        payload: { model: "weak" as const },
    };

    it("moves the row out of the outbox with its reason and the whole original request", async () => {
        const db = makeDb();
        await addRequests(db, [row]);

        await deadLetterRequests(db, [{ request: row, reason: "nope" }], new Date("2026-10-18T00:00:00Z"));

        expect(await getRequests(db, "u1")).toHaveLength(0);
        const [deadLetter] = await getDeadLetterRequests(db, "u1");
        expect(deadLetter.reason).toBe("nope");
        expect(deadLetter.songId).toBe("s1");
        expect(deadLetter.userId).toBe("u1");
        expect(deadLetter.request.payload).toEqual({ model: "weak" });
    });

    it("finishes a move interrupted after the insert: no error, outbox row removed, one dead letter", async () => {
        const db = makeDb();
        await addRequests(db, [row]);
        await db.insert(deadLetterRequestTable).values({
            requestId: "r1", requestType: row.requestType, userId: "u1", timeRequested: row.timeRequested,
            deadLetteredAt: new Date(), reason: "first try", request: row,
        });

        await deadLetterRequests(db, [{ request: row, reason: "second try" }]);

        expect(await getRequests(db, "u1")).toHaveLength(0);
        const deadLetters = await getDeadLetterRequests(db, "u1");
        expect(deadLetters.map(x => x.reason)).toEqual(["first try"]);
    });
});
