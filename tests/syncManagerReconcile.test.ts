import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { eq } from "drizzle-orm";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { getAllSongIds, updateSongs } from "@/app/services/db/queries/song";
import { artistTable, downloadedSongTable, downloadQueueTable, playlistSongTable, playlistTable, recentlyPlayedSongTable, songArtistTable, songTagTable, tagTable, userSongTable, userTable } from "@/app/services/db/schema";
import type { Song } from "@/app/services/db/models";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { SONG_RECONCILE_INTERVAL_MS, SONG_RECONFIRM_INTERVAL_MS } from "@/app/services/sync-manager/syncLogic";
import { ApiStatusFailureError } from "@/app/services/api/errors";

const { storage, deleteLocalSongFiles } = vi.hoisted(() => ({
    storage: new Map<string, string>(),
    deleteLocalSongFiles: vi.fn(async (_song: { songId: string }) => {}),
}));

vi.mock("@/app/tools", () => import("@/app/tools/pure"));
vi.mock("@/app/services/downloader/Downloader", () => ({ Downloader: { deleteLocalSongFiles } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
    default: {
        getItem: async (key: string) => storage.get(key) ?? null,
        setItem: async (key: string, value: string) => { storage.set(key, value); },
    },
}));

const { SyncManager } = await import("@/app/services/sync-manager/SyncManager");

const USER = "u1";

// The real schema from the app's migrations. better-sqlite3 enforces foreign keys, so the purge's delete order is checked too.
function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

function song(id: string, fileHash = `hash-${id}`): Song {
    return {
        songId: id, fileExtension: ".mp3", fileHash, name: `Song ${id}`,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, energy: null, exploratory: false, tagsStale: false,
    };
}

// Every local row that points at a song, so the purge can be checked table by table.
async function addEverything(db: GenericDb, songId: string) {
    await db.insert(songArtistTable).values({ songArtistId: `sa-${songId}`, songId, artistId: "a1" });
    await db.insert(songTagTable).values({ songTagId: `st-${songId}`, songId, tagId: "t1" });
    await db.insert(userSongTable).values({ userId: USER, songId, lastPlayed: new Date(), version: new Date(), likeStatus: 0 });
    await db.insert(playlistSongTable).values({ playlistSongId: `ps-${songId}`, playlistId: "p1", songId });
    await db.insert(downloadedSongTable).values({ downloadedSongId: `d-${songId}`, songId });
    await db.insert(downloadQueueTable).values({ downloadQueueId: `q-${songId}`, songId, priority: 0 });
    await db.insert(recentlyPlayedSongTable).values({ recentlyPlayedSongId: `r-${songId}`, songId, timestampSeconds: 0, lastPlayed: new Date() });
}

async function rowsFor(db: GenericDb, songId: string) {
    const tables = [songArtistTable, songTagTable, userSongTable, playlistSongTable, downloadedSongTable, downloadQueueTable, recentlyPlayedSongTable];
    let count = 0;
    for (const table of tables) {
        count += (await db.select().from(table).where(eq(table.songId, songId))).length;
    }
    return count;
}

// The server: holds `serverSongIds`, and answers /songs/list with whichever of the requested ids it has.
function makeApi(serverSongIds: string[]) {
    const server = new Set(serverSongIds);
    return {
        server,
        songGetList: vi.fn(async (songIds: string[]) => songIds.filter(x => server.has(x)).map(songId => ({ songId }))),
    };
}

function makeManager(db: GenericDb, api: ReturnType<typeof makeApi>) {
    const manager = Object.create(SyncManager.prototype);
    Object.assign(manager, { db, api, userId: USER, logout: vi.fn(async () => {}), syncing: false, keepRetriedAt: new Map() });
    manager.overallSync = vi.fn(async () => 200);
    return manager as { sync(): Promise<void>; overallSync: () => Promise<number> };
}

const HOST = "https://shuffull-api.example";

// Moves the last check back a day, so the next sync checks again whatever kind of check is due.
function intervalPasses() {
    const last = Number(storage.get(STORAGE_KEYS.SONG_RECONCILE_AT));
    storage.set(STORAGE_KEYS.SONG_RECONCILE_AT, String(last - SONG_RECONCILE_INTERVAL_MS));
}

const misses = () => JSON.parse(storage.get(STORAGE_KEYS.SONG_RECONCILE_STATE)!).misses;

describe("SyncManager: songs deleted on the server are removed locally", () => {
    let db: GenericDb;
    beforeEach(async () => {
        storage.clear();
        storage.set(STORAGE_KEYS.HOST_ADDRESS, HOST);
        deleteLocalSongFiles.mockClear();
        db = makeDb();
        await db.insert(userTable).values({ userId: USER, username: "max", version: new Date(), isCurator: false });
        await db.insert(playlistTable).values({ playlistId: "p1", userId: USER, name: "p1", percentUntilReplayable: 0.9, version: new Date() });
        await db.insert(artistTable).values({ artistId: "a1", name: "Artist" });
        await db.insert(tagTable).values({ tagId: "t1", name: "rock", type: 0 });
    });

    it("removes a song the server no longer has on the second check in a row, with every row and file", async () => {
        await updateSongs(db, [song("live"), song("ghost")]);
        await addEverything(db, "live");
        await addEverything(db, "ghost");
        const api = makeApi(["live"]);

        await makeManager(db, api).sync();
        expect(await getAllSongIds(db)).toEqual(expect.arrayContaining(["live", "ghost"]));
        expect(misses()).toEqual(["ghost"]);

        intervalPasses();
        await makeManager(db, api).sync();

        // The confirming check asks only about the song the first one missed.
        expect(api.songGetList.mock.calls[1][0]).toEqual(["ghost"]);
        expect(await getAllSongIds(db)).toEqual(["live"]);
        expect(await rowsFor(db, "ghost")).toBe(0);
        expect(await rowsFor(db, "live")).toBe(7);
        expect(deleteLocalSongFiles).toHaveBeenCalledTimes(1);
        expect(deleteLocalSongFiles.mock.calls[0][0].songId).toBe("ghost");
        expect(misses()).toEqual([]);
    });

    it("keeps a song that comes back after one miss", async () => {
        await updateSongs(db, [song("s1"), song("flaky")]);
        const api = makeApi(["s1"]);

        await makeManager(db, api).sync();
        api.server.add("flaky");
        intervalPasses();
        await makeManager(db, api).sync();

        expect(await getAllSongIds(db)).toEqual(expect.arrayContaining(["s1", "flaky"]));
        expect(misses()).toEqual([]);
    });

    it("removes nothing when the server has almost none of the library", async () => {
        await updateSongs(db, [song("s1"), song("s2"), song("s3")]);
        const api = makeApi([]);

        for (let i = 0; i < 3; i++) {
            await makeManager(db, api).sync();
            intervalPasses();
        }

        expect(await getAllSongIds(db)).toHaveLength(3);
        expect(misses()).toEqual([]);
        expect(deleteLocalSongFiles).not.toHaveBeenCalled();
    });

    it("does not confirm a miss seen on another server", async () => {
        await updateSongs(db, [song("s1"), song("s2"), song("ghost")]);
        const api = makeApi(["s1", "s2"]);

        await makeManager(db, api).sync();
        expect(misses()).toEqual(["ghost"]);
        storage.set(STORAGE_KEYS.HOST_ADDRESS, "https://other.example");
        intervalPasses();
        await makeManager(db, api).sync();

        // The second server's check is a fresh full one, so the song is only remembered again, not removed.
        expect(await getAllSongIds(db)).toContain("ghost");
        expect(misses()).toEqual(["ghost"]);
    });

    it("checks every local song, 500 ids per call", async () => {
        const ids = Array.from({ length: 1201 }, (_, i) => `s${i}`);
        await updateSongs(db, ids.map(x => song(x)));
        const api = makeApi(ids);

        await makeManager(db, api).sync();

        expect(api.songGetList.mock.calls.map(([batch]) => batch.length)).toEqual([500, 500, 201]);
    });

    it("counts nothing as missing when any call fails", async () => {
        const ids = Array.from({ length: 600 }, (_, i) => `s${i}`);
        await updateSongs(db, ids.map(x => song(x)));
        const api = makeApi(ids.slice(0, 590));
        api.songGetList
            .mockImplementationOnce(async (songIds: string[]) => songIds.map(songId => ({ songId })))
            .mockRejectedValueOnce(new ApiStatusFailureError("/api/v1/songs/list", { status: 503, data: {} }));

        await makeManager(db, api).sync();

        expect(await getAllSongIds(db)).toHaveLength(600);
        expect(storage.has(STORAGE_KEYS.SONG_RECONCILE_STATE)).toBe(false);
        expect(deleteLocalSongFiles).not.toHaveBeenCalled();
    });

    it("runs a full check at most once a day", async () => {
        await updateSongs(db, [song("s1")]);
        const api = makeApi(["s1"]);

        await makeManager(db, api).sync();
        const last = Number(storage.get(STORAGE_KEYS.SONG_RECONCILE_AT));
        storage.set(STORAGE_KEYS.SONG_RECONCILE_AT, String(last - SONG_RECONFIRM_INTERVAL_MS));
        await makeManager(db, api).sync();

        expect(api.songGetList).toHaveBeenCalledTimes(1);
    });

    it("does not check when the pull failed", async () => {
        await updateSongs(db, [song("s1")]);
        const api = makeApi([]);
        const manager = makeManager(db, api);
        manager.overallSync = vi.fn(async () => 503);

        await manager.sync();

        expect(api.songGetList).not.toHaveBeenCalled();
        expect(storage.has(STORAGE_KEYS.SONG_RECONCILE_AT)).toBe(false);
    });

    it("keeps the file of a removed song when another local song uses the same audio", async () => {
        await updateSongs(db, [song("ghost", "same-audio"), song("reimported", "same-audio")]);
        const api = makeApi(["reimported"]);

        await makeManager(db, api).sync();
        intervalPasses();
        await makeManager(db, api).sync();

        expect(await getAllSongIds(db)).toEqual(["reimported"]);
        expect(deleteLocalSongFiles).not.toHaveBeenCalled();
    });
});
