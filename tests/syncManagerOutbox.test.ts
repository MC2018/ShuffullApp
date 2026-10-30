import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { addRequests, enqueueSongRetag, getDeadLetterRequests, getRequests } from "@/app/services/db/queries/request";
import { deadLetterRequestTable, userTable } from "@/app/services/db/schema";
import { RequestType } from "@/app/enums";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import type { KeepResponse } from "@/app/services/api/models";

// SyncManager's own imports reach native modules (the downloader, async-storage, argon2 via the tools barrel).
// None of them run during the push phase tested here, so they are stubbed and the real SyncManager is exercised.
vi.mock("@/app/tools", () => import("@/app/tools/pure"));
vi.mock("@/app/services/downloader/Downloader", () => ({ Downloader: {} }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => {} } }));

const { SyncManager } = await import("@/app/services/sync-manager/SyncManager");

const USER = "u1";

// The real schema, built by running the app's own migrations, so the dead-letter table is the shipped one.
function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

function rejected(endpoint: string, status: number, error: string) {
    return new ApiStatusFailureError(endpoint, { status, data: { error } });
}

function makeApi() {
    return {
        songKeep: vi.fn(async (songIds: string[]): Promise<KeepResponse> => ({
            results: songIds.map(songId => ({ songId, outcome: "kept", error: null })),
        })),
        songRetag: vi.fn(async (items: { songId: string }[]) => ({
            results: items.map(x => ({ songId: x.songId, outcome: "enriched", error: null })),
        })),
        playlistDelete: vi.fn(async (_playlistId: string) => {}),
    };
}

// Built without the constructor, which starts a 10s timer and an immediate sync. The pull phase is out of scope
// here, so overallSync is stubbed to succeed.
function makeManager(db: GenericDb, api: ReturnType<typeof makeApi>, logout = vi.fn(async () => {})) {
    const manager = Object.create(SyncManager.prototype);
    Object.assign(manager, { db, api, userId: USER, logout, syncing: false, keepRetriedAt: new Map(), failedSyncs: 0, ticksToSkip: 0 });
    manager.overallSync = vi.fn(async () => 200);
    return manager as {
        sync(): Promise<void>;
        keepRetriedAt: Map<string, number>;
        overallSync: () => Promise<number>;
        failedSyncs: number;
        ticksToSkip: number;
        syncNow(): void;
    };
}

async function setCurator(db: GenericDb, isCurator: boolean) {
    await db.insert(userTable).values({ userId: USER, username: "max", version: new Date(), isCurator });
}

async function queueDelete(db: GenericDb, playlistId: string, at = new Date(), songIds: string[] | null = []) {
    await addRequests(db, [{
        requestId: `delete-${playlistId}`,
        timeRequested: at,
        requestType: RequestType.DeletePlaylist,
        userId: USER,
        playlistId,
        payload: songIds ? { songIds } : null,
    }]);
}

// Leaves a Keep for `songId` in the dead-letter table, the way a refused Keep gets there.
async function deadLetterKeep(db: GenericDb, api: ReturnType<typeof makeApi>, songId: string) {
    await enqueueSongRetag(db, USER, songId, "weak");
    api.songKeep.mockResolvedValueOnce({ results: [{ songId, outcome: "failed", error: "nope" }] });
    await makeManager(db, api).sync();
    expect(await getDeadLetterRequests(db, USER)).toHaveLength(1);
}

describe("SyncManager: a Keep is recorded through /songs/keep, for every user", () => {
    let db: GenericDb;
    let api: ReturnType<typeof makeApi>;
    beforeEach(() => { db = makeDb(); api = makeApi(); });

    it("a non-curator's Keep goes to /keep, never to the curator-only /retag", async () => {
        await setCurator(db, false);
        await enqueueSongRetag(db, USER, "s1", "weak");

        await makeManager(db, api).sync();

        expect(api.songKeep).toHaveBeenCalledWith(["s1"]);
        expect(api.songRetag).not.toHaveBeenCalled();
        expect(await getRequests(db, USER)).toHaveLength(0);
        expect(await getDeadLetterRequests(db, USER)).toHaveLength(0);
    });

    it("a curator's Keep is recorded first, then re-tagged at its tier", async () => {
        await setCurator(db, true);
        await enqueueSongRetag(db, USER, "s1", "weak");
        await enqueueSongRetag(db, USER, "s2", "strong");

        await makeManager(db, api).sync();

        expect(api.songKeep).toHaveBeenCalledWith(["s1", "s2"]);
        expect(api.songKeep.mock.invocationCallOrder[0]).toBeLessThan(api.songRetag.mock.invocationCallOrder[0]);
        expect(api.songRetag).toHaveBeenCalledWith([{ songId: "s1", model: "weak" }, { songId: "s2", model: "strong" }]);
        expect(await getRequests(db, USER)).toHaveLength(0);
    });

    it("a failed re-tag after a recorded Keep costs the tags, not the rows' disposal", async () => {
        await setCurator(db, true);
        await enqueueSongRetag(db, USER, "s1", "weak");
        api.songRetag.mockRejectedValueOnce(rejected("/api/v1/songs/retag", 400, "AI is not enabled"));

        await makeManager(db, api).sync();

        expect(await getRequests(db, USER)).toHaveLength(0);
        expect(await getDeadLetterRequests(db, USER)).toHaveLength(0);
    });

    it("a song the server did not keep is dead-lettered with its reason, not deleted", async () => {
        await setCurator(db, true);
        await enqueueSongRetag(db, USER, "mine", "weak");
        await enqueueSongRetag(db, USER, "notMine", "weak");
        api.songKeep.mockResolvedValueOnce({
            results: [
                { songId: "mine", outcome: "kept", error: null },
                { songId: "notMine", outcome: "failed", error: "Song is not in your library." },
            ],
        });

        await makeManager(db, api).sync();

        const deadLetters = await getDeadLetterRequests(db, USER);
        expect(deadLetters.map(x => [x.songId, x.reason])).toEqual([["notMine", "Song is not in your library."]]);
        expect(api.songRetag).toHaveBeenCalledWith([{ songId: "mine", model: "weak" }]);
        expect(await getRequests(db, USER)).toHaveLength(0);
    });

    it("a 401 logs out instead of being read as 'server down'", async () => {
        await enqueueSongRetag(db, USER, "s1", "weak");
        api.songKeep.mockRejectedValueOnce(rejected("/api/v1/songs/keep", 401, "expired"));
        const logout = vi.fn(async () => {});

        await makeManager(db, api, logout).sync();

        expect(logout).toHaveBeenCalledOnce();
        expect(await getRequests(db, USER)).toHaveLength(1);
    });
});

describe("SyncManager: playlist deletes wait for every Keep (the 2026-08-22 purge)", () => {
    let db: GenericDb;
    let api: ReturnType<typeof makeApi>;
    beforeEach(() => { db = makeDb(); api = makeApi(); });

    it("a rejected Keep is retained AND holds the playlist delete queued behind it", async () => {
        await enqueueSongRetag(db, USER, "kept", "weak");
        await queueDelete(db, "mix", new Date(Date.now() + 1));
        api.songKeep.mockRejectedValue(rejected("/api/v1/songs/keep", 400, "boom"));

        await makeManager(db, api).sync();

        expect(api.playlistDelete).not.toHaveBeenCalled();
        expect((await getRequests(db, USER)).map(x => x.requestType).sort())
            .toEqual([RequestType.SongRetag, RequestType.DeletePlaylist].sort());
    });

    it("once the Keep is recorded, the delete goes in the same flush", async () => {
        await enqueueSongRetag(db, USER, "kept", "weak");
        await queueDelete(db, "mix", new Date(Date.now() + 1));

        await makeManager(db, api).sync();

        expect(api.songKeep.mock.invocationCallOrder[0]).toBeLessThan(api.playlistDelete.mock.invocationCallOrder[0]);
        expect(await getRequests(db, USER)).toHaveLength(0);
    });

    it("a delete queued BEFORE a Keep is held for that flush, and goes on the next", async () => {
        await queueDelete(db, "mix", new Date(Date.now() - 1000));
        await enqueueSongRetag(db, USER, "kept", "weak");
        const manager = makeManager(db, api);

        await manager.sync();
        expect(api.playlistDelete).not.toHaveBeenCalled();

        await manager.sync();
        expect(api.playlistDelete).toHaveBeenCalledWith("mix");
        expect(await getRequests(db, USER)).toHaveLength(0);
    });

    it("a dead-lettered Keep holds the delete of a playlist that holds its song", async () => {
        await deadLetterKeep(db, api, "kept");
        api.songKeep.mockResolvedValueOnce({ results: [{ songId: "kept", outcome: "failed", error: "still no" }] });
        await queueDelete(db, "mix", new Date(), ["kept", "other"]);

        await makeManager(db, api).sync();

        expect(api.songKeep).toHaveBeenLastCalledWith(["kept"]); // the hold re-sends the Keep it is waiting on
        expect(api.playlistDelete).not.toHaveBeenCalled();
        expect(await getRequests(db, USER)).toHaveLength(1);
    });

    it("...and lets it go once the re-sent Keep is recorded", async () => {
        await deadLetterKeep(db, api, "kept");
        await queueDelete(db, "mix", new Date(), ["kept"]);

        await makeManager(db, api).sync();

        expect(api.playlistDelete).toHaveBeenCalledWith("mix");
        expect(await getDeadLetterRequests(db, USER)).toHaveLength(0);
        expect(await getRequests(db, USER)).toHaveLength(0);
    });

    it("a dead-lettered Keep does not hold the delete of a playlist without its song", async () => {
        await deadLetterKeep(db, api, "kept");
        await queueDelete(db, "unrelated", new Date(), ["other"]);

        await makeManager(db, api).sync();

        expect(api.playlistDelete).toHaveBeenCalledWith("unrelated");
        expect(await getDeadLetterRequests(db, USER)).toHaveLength(1);
    });

    it("an older delete row that doesn't record its songs is held by any dead-lettered Keep", async () => {
        await deadLetterKeep(db, api, "kept");
        api.songKeep.mockResolvedValueOnce({ results: [{ songId: "kept", outcome: "failed", error: "still no" }] });
        await queueDelete(db, "legacy", new Date(), null);

        await makeManager(db, api).sync();

        expect(api.playlistDelete).not.toHaveBeenCalled();
    });

    it("another account's dead letters hold nothing", async () => {
        await deadLetterKeep(db, api, "kept");
        await db.update(deadLetterRequestTable).set({ userId: "someone-else" });
        await queueDelete(db, "mix", new Date(), ["kept"]);

        await makeManager(db, api).sync();

        expect(api.playlistDelete).toHaveBeenCalledWith("mix");
    });

    it("a held Keep is re-sent at most once an hour, not on every flush", async () => {
        await deadLetterKeep(db, api, "kept");
        api.songKeep.mockResolvedValue({ results: [{ songId: "kept", outcome: "failed", error: "still no" }] });
        await queueDelete(db, "mix", new Date(), ["kept"]);
        const manager = makeManager(db, api);
        const calls = () => api.songKeep.mock.calls.length;

        await manager.sync();
        const afterFirst = calls();
        await manager.sync();
        expect(calls()).toBe(afterFirst);

        manager.keepRetriedAt.set("kept", Date.now() - 61 * 60 * 1000);
        await manager.sync();
        expect(calls()).toBe(afterFirst + 1);
        expect(api.playlistDelete).not.toHaveBeenCalled();
    });

    it("a 401 while re-sending a held Keep logs out", async () => {
        await deadLetterKeep(db, api, "kept");
        await queueDelete(db, "mix", new Date(), ["kept"]);
        api.songKeep.mockRejectedValueOnce(rejected("/api/v1/songs/keep", 401, "expired"));
        const logout = vi.fn(async () => {});

        await makeManager(db, api, logout).sync();

        expect(logout).toHaveBeenCalledOnce();
        expect(api.playlistDelete).not.toHaveBeenCalled();
    });

    it("a 5xx while re-sending a held Keep ends the flush and is retried next flush, not an hour later", async () => {
        await deadLetterKeep(db, api, "kept");
        await queueDelete(db, "mix", new Date(), ["kept"]);
        api.songKeep.mockRejectedValueOnce(rejected("/api/v1/songs/keep", 503, "down"));
        const manager = makeManager(db, api);

        await manager.sync();
        expect(api.playlistDelete).not.toHaveBeenCalled();
        expect(manager.overallSync).not.toHaveBeenCalled();

        await manager.sync(); // the next tick: one failure sits out no ticks
        expect(api.playlistDelete).toHaveBeenCalledWith("mix");
    });

    it("more than 200 held Keeps are re-sent in chunks the server accepts", async () => {
        const songIds = Array.from({ length: 450 }, (_, i) => `s${i}`);
        await db.insert(deadLetterRequestTable).values(songIds.map(songId => ({
            requestId: `keep-${songId}`, requestType: RequestType.SongRetag, userId: USER, songId,
            timeRequested: new Date(), deadLetteredAt: new Date(), reason: "nope",
            request: { requestId: `keep-${songId}`, requestType: RequestType.SongRetag, userId: USER, songId, timeRequested: new Date() },
        })));
        await queueDelete(db, "legacy", new Date(), null);

        await makeManager(db, api).sync();

        expect(api.songKeep.mock.calls.map(([ids]) => ids.length)).toEqual([200, 200, 50]);
        expect(api.playlistDelete).toHaveBeenCalledWith("legacy");
        expect(await getDeadLetterRequests(db, USER)).toHaveLength(0);
    });

    it("with no Keep anywhere, a delete is sent straight away", async () => {
        await queueDelete(db, "mix");

        await makeManager(db, api).sync();

        expect(api.playlistDelete).toHaveBeenCalledWith("mix");
    });

    it("a Keep rejected past the retry window is dead-lettered, never dropped", async () => {
        await addRequests(db, [{
            requestId: "old-keep",
            timeRequested: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
            requestType: RequestType.SongRetag,
            userId: USER,
            songId: "kept",
            payload: { model: "weak" },
        }]);
        api.songKeep.mockRejectedValue(rejected("/api/v1/songs/keep", 400, "boom"));

        await makeManager(db, api).sync();

        const deadLetters = await getDeadLetterRequests(db, USER);
        expect(await getRequests(db, USER)).toHaveLength(0);
        expect(deadLetters).toHaveLength(1);
        expect(deadLetters[0].reason).toContain("400");
        expect(deadLetters[0].reason).toContain("boom");
    });
});

describe("SyncManager: outbox hardening (ShuffullApp#93)", () => {
    let db: GenericDb;
    let api: ReturnType<typeof makeApi>;
    beforeEach(() => { db = makeDb(); api = makeApi(); });

    it("a Like that upgrades a Keep while the Keep is in flight is not deleted with it", async () => {
        await setCurator(db, true);
        await enqueueSongRetag(db, USER, "s1", "weak");
        api.songKeep.mockImplementationOnce(async (songIds: string[]) => {
            await enqueueSongRetag(db, USER, "s1", "strong"); // the user likes the song mid-flush
            return { results: songIds.map(songId => ({ songId, outcome: "kept", error: null })) };
        });
        const manager = makeManager(db, api);

        await manager.sync();
        expect(api.songRetag).toHaveBeenLastCalledWith([{ songId: "s1", model: "weak" }]);
        const [row] = await getRequests(db, USER);
        expect(row.payload).toEqual({ model: "strong" });

        await manager.sync();
        expect(api.songRetag).toHaveBeenLastCalledWith([{ songId: "s1", model: "strong" }]);
        expect(await getRequests(db, USER)).toHaveLength(0);
    });

    it("another account's rows are not sent with this account's token, and wait for their owner", async () => {
        await enqueueSongRetag(db, "someone-else", "theirs", "weak");
        await enqueueSongRetag(db, USER, "mine", "weak");

        await makeManager(db, api).sync();

        expect(api.songKeep).toHaveBeenCalledExactlyOnceWith(["mine"]);
        expect(await getRequests(db, USER)).toHaveLength(0);
        expect((await getRequests(db, "someone-else")).map(x => x.songId)).toEqual(["theirs"]);
    });

    it("an unreachable server backs the syncs off, and a success resets it", async () => {
        await enqueueSongRetag(db, USER, "s1", "weak");
        api.songKeep.mockRejectedValue(rejected("/api/v1/songs/keep", 503, "down"));
        const manager = makeManager(db, api);

        await manager.sync();
        await manager.sync(); // one failure: the very next tick tries again
        expect(api.songKeep).toHaveBeenCalledTimes(2);
        expect(manager.failedSyncs).toBe(2);

        await manager.sync(); // two failures: this tick is sat out
        expect(api.songKeep).toHaveBeenCalledTimes(2);

        api.songKeep.mockReset();
        api.songKeep.mockResolvedValue({ results: [{ songId: "s1", outcome: "kept", error: null }] });
        await manager.sync();
        expect(manager.failedSyncs).toBe(0);
        expect(manager.ticksToSkip).toBe(0);
        expect(await getRequests(db, USER)).toHaveLength(0);
    });

    it("syncNow drops the backoff and syncs at once, for a connection that is back", async () => {
        await enqueueSongRetag(db, USER, "s1", "weak");
        const manager = makeManager(db, api);
        manager.failedSyncs = 6;
        manager.ticksToSkip = 29;

        manager.syncNow();
        await vi.waitFor(() => expect(manager.overallSync).toHaveBeenCalled());

        expect(api.songKeep).toHaveBeenCalledWith(["s1"]);
        expect(manager.failedSyncs).toBe(0);
        expect(manager.ticksToSkip).toBe(0);
    });

    it("a failed pull counts as a failed sync", async () => {
        const manager = makeManager(db, api);
        manager.overallSync = vi.fn(async () => 503);

        await manager.sync();

        expect(manager.failedSyncs).toBe(1);
    });

    it("a throw inside sync is logged and counted, never rejected into the interval", async () => {
        const manager = makeManager(db, api);
        manager.overallSync = vi.fn(async () => { throw new Error("driver broke"); });
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(manager.sync()).resolves.toBeUndefined();

        expect(manager.failedSyncs).toBe(1);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
});
