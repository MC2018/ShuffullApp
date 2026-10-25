import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as betterSqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as expoDrizzle } from "drizzle-orm/expo-sqlite/driver";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import DbQueries from "@/app/services/db/queries";
import { localSessionDataTable, playlistSongTable, playlistTable, songTable, userTable } from "@/app/services/db/schema";
import { enqueueSongRetag, getRequests } from "@/app/services/db/queries/request";
import { withTransaction } from "@/app/services/db/transaction";

let songCursor: string | null = null;
vi.mock("@/app/tools", () => import("@/app/tools/pure"));
vi.mock("@/app/services/downloader/Downloader", () => ({ Downloader: { deleteLocalSongFiles: async () => {} } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
    default: { getItem: async () => songCursor, setItem: async (_key: string, value: string) => { songCursor = value; } },
}));

const { SyncManager } = await import("@/app/services/sync-manager/SyncManager");

const USER = "u1";
const OLD_VERSION = new Date("2026-01-01T00:00:00Z");
const NEW_VERSION = new Date("2026-02-01T00:00:00Z");
const CURSOR = "2026-01-01T00:00:00.000Z";

/**
 * The phone's driver, drizzle-orm/expo-sqlite, over an in-memory better-sqlite3 database.
 *
 * Using the better-sqlite3 driver here would miss the bug. Its db.transaction() rejects an async callback outright
 * ("Transaction function cannot return a promise"), so master failed loudly in the tests. Expo's runs BEGIN, calls
 * the callback and COMMITs without awaiting it, so on the phone every write autocommitted and nothing rolled back
 * (ShuffullApp#91). Only that driver's session shows that, so this hands it the few expo-sqlite calls it makes.
 */
function makeDb(): GenericDb {
    const sqlite = new Database(":memory:");
    // better-sqlite3 enforces foreign keys by default; expo-sqlite on the device doesn't, and the app never turns them
    // on. Sync's delete-then-insert upserts (users, songs) rely on that, so match the device.
    sqlite.pragma("foreign_keys = OFF");
    migrate(betterSqliteDrizzle(sqlite), { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });

    const client = {
        prepareSync(source: string) {
            return {
                executeSync(params: unknown[]) {
                    const stmt = sqlite.prepare(source);
                    if (!stmt.reader) {
                        const { changes, lastInsertRowid } = stmt.run(...params);
                        return { changes, lastInsertRowId: Number(lastInsertRowid), getAllSync: () => [], getFirstSync: () => null };
                    }
                    const rows = stmt.all(...params);
                    return { changes: 0, lastInsertRowId: 0, getAllSync: () => rows, getFirstSync: () => rows[0] ?? null };
                },
                executeForRawResultSync(params: unknown[]) {
                    const rows = sqlite.prepare(source).raw(true).all(...params);
                    return { getAllSync: () => rows };
                },
            };
        },
    };
    return expoDrizzle(client as unknown as Parameters<typeof expoDrizzle>[0]) as unknown as GenericDb;
}

function apiSong(songId: string, name: string, fileHash = `hash-${songId}`) {
    return {
        songId, name, fileHash, fileExtension: "mp3", artists: [], tags: [],
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, heaviness: null, exploratory: false, tagsStale: false,
    };
}

// The server's view after a change: the user moved on, playlist p1 was renamed and gained song s2, and the existing
// song s1 changed. `changedS1` lets a test hand back a row the local insert will reject.
function makeApi(changedS1: object) {
    return {
        userGet: vi.fn(async () => ({ userId: USER, username: "max", version: NEW_VERSION, isCurator: false })),
        tagGetAll: vi.fn(async () => []),
        playlistGetAll: vi.fn(async () => [{ playlistId: "p1", version: NEW_VERSION }]),
        playlistGetList: vi.fn(async () => [{
            playlistId: "p1", userId: USER, name: "Renamed", percentUntilReplayable: 0.5,
            version: NEW_VERSION, songIds: ["s1", "s2"], isExploratory: false,
        }]),
        userSongGetAll: vi.fn(async () => ({ items: [], endOfList: true })),
        songGetList: vi.fn(async () => [apiSong("s2", "New song")]),
        songGetChanged: vi.fn(async () => ({ items: [{ ...changedS1, version: NEW_VERSION }], endOfList: true })),
    };
}

function makeManager(db: GenericDb, api: ReturnType<typeof makeApi>) {
    const manager = Object.create(SyncManager.prototype);
    Object.assign(manager, { db, api, userId: USER, logout: async () => {}, syncing: false, keepRetriedAt: new Map() });
    return manager as { overallSync(): Promise<number> };
}

// What the device held before the sync: a signed-in user at OLD_VERSION, and playlist p1 holding song s1.
async function seed(db: GenericDb) {
    await db.insert(userTable).values({ userId: USER, username: "max", version: OLD_VERSION, isCurator: false });
    await db.insert(localSessionDataTable).values({
        userId: USER, activelyDownload: false, token: "t", expiration: new Date(Date.now() + 86_400_000),
    });
    await db.insert(songTable).values({ songId: "s1", name: "Original", fileExtension: "mp3", fileHash: "hash-s1" });
    await db.insert(playlistTable).values({
        playlistId: "p1", userId: USER, name: "Original", percentUntilReplayable: 0.5, version: OLD_VERSION,
    });
    await db.insert(playlistSongTable).values({ playlistSongId: "ps-s1", playlistId: "p1", songId: "s1" });
}

async function snapshot(db: GenericDb) {
    return {
        user: await db.select().from(userTable),
        songs: await db.select().from(songTable).orderBy(songTable.songId),
        playlists: await db.select().from(playlistTable),
        playlistSongs: await db.select().from(playlistSongTable).orderBy(playlistSongTable.songId),
    };
}

describe("overallSync: the write phase is all-or-nothing", () => {
    let db: GenericDb;
    let syncError: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

    // overallSync logs the error and returns 500, so this is the only way to see the failure was the intended one
    // and not something earlier in the write phase.
    const failedWith = () => String(syncError.mock.calls[0]?.[1]);

    beforeEach(async () => {
        db = makeDb();
        await seed(db);
        songCursor = CURSOR;
        syncError = vi.fn<(...args: unknown[]) => void>();
        vi.spyOn(console, "error").mockImplementation(syncError);
    });

    afterEach(() => vi.restoreAllMocks());

    it("a row the insert rejects partway leaves every table as it was, s1 included", async () => {
        const before = await snapshot(db);

        // name is NOT NULL locally. updateSongs deletes s1 before inserting its replacement, so without a real
        // transaction this left s1 deleted, and p1 already renamed and pointing at a song that no longer exists.
        const status = await makeManager(db, makeApi({ ...apiSong("s1", "Changed", "hash-s1-v2"), name: null })).overallSync();

        expect(status).toBe(500);
        expect(failedWith()).toMatch(/NOT NULL constraint failed: songs\.name/);
        expect(await snapshot(db)).toEqual(before);
        // The song cursor is only written after a commit, so the same change is fetched again next time.
        expect(songCursor).toBe(CURSOR);
    });

    it("a failure after the user is written rolls the user's version back", async () => {
        const before = await snapshot(db);
        const realUpdateUser = DbQueries.updateUser;
        vi.spyOn(DbQueries, "updateUser").mockImplementation(async (tx, user) => {
            await realUpdateUser(tx, user);
            throw new Error("disk I/O error");
        });

        const status = await makeManager(db, makeApi(apiSong("s1", "Changed", "hash-s1-v2"))).overallSync();

        // users.version is the afterDate of the next user-song fetch. Had it stuck at NEW_VERSION, the user-song
        // changes from this window would never be fetched again.
        expect(status).toBe(500);
        expect(failedWith()).toMatch(/disk I\/O error/);
        expect(await snapshot(db)).toEqual(before);
    });

    it("a Keep queued while sync is writing survives the sync's rollback", async () => {
        // The user taps Keep while the write phase is mid-way. Its outbox row must not join the sync's transaction:
        // that would roll it back with the sync, the 2026-08-22 way of losing a Keep.
        let keep: Promise<void> | undefined;
        const realUpdateTags = DbQueries.updateTags;
        vi.spyOn(DbQueries, "updateTags").mockImplementation(async (tx, tags) => {
            await realUpdateTags(tx, tags);
            keep = enqueueSongRetag(db, USER, "s1", "weak");
            await new Promise(resolve => setTimeout(resolve, 0)); // give the Keep every chance to run now
        });

        const status = await makeManager(db, makeApi({ ...apiSong("s1", "Changed", "hash-s1-v2"), name: null })).overallSync();
        await keep;

        expect(status).toBe(500);
        expect((await getRequests(db)).map(x => x.songId)).toEqual(["s1"]);
    });

    it("commits everything when nothing fails", async () => {
        const status = await makeManager(db, makeApi(apiSong("s1", "Changed", "hash-s1-v2"))).overallSync();

        expect(status).toBe(200);
        expect(syncError).not.toHaveBeenCalled();
        const after = await snapshot(db);
        expect(after.user[0].version).toEqual(NEW_VERSION);
        expect(after.playlists[0].name).toBe("Renamed");
        expect(after.songs.map(x => [x.songId, x.name])).toEqual([["s1", "Changed"], ["s2", "New song"]]);
        expect(after.playlistSongs.map(x => x.songId)).toEqual(["s1", "s2"]);
        expect(songCursor).toBe(NEW_VERSION.toISOString());
    });
});

describe("withTransaction", () => {
    let db: GenericDb;

    beforeEach(async () => {
        db = makeDb();
        await seed(db);
    });

    const userVersion = async () => (await db.select().from(userTable).where(eq(userTable.userId, USER)))[0].version;

    it("rolls back writes made before the throw and rethrows the original error", async () => {
        await expect(withTransaction(db, async tx => {
            await tx.update(userTable).set({ version: NEW_VERSION });
            throw new Error("boom");
        })).rejects.toThrow("boom");

        expect(await userVersion()).toEqual(OLD_VERSION);
    });

    it("leaves no transaction open after a failure, so the next one can begin", async () => {
        await withTransaction(db, async () => { throw new Error("boom"); }).catch(() => {});

        await withTransaction(db, async tx => { await tx.update(userTable).set({ version: NEW_VERSION }); });
        expect(await userVersion()).toEqual(NEW_VERSION);
    });

    it("runs one transaction at a time, so a second one's writes aren't caught in the first one's rollback", async () => {
        let second: Promise<void> | undefined;
        await expect(withTransaction(db, async tx => {
            await tx.update(userTable).set({ version: NEW_VERSION });
            second = withTransaction(db, async other => { await other.update(userTable).set({ username: "renamed" }); });
            await new Promise(resolve => setTimeout(resolve, 0));
            throw new Error("boom");
        })).rejects.toThrow("boom");
        await second;

        const [user] = await db.select().from(userTable);
        expect(user.version).toEqual(OLD_VERSION);
        expect(user.username).toBe("renamed");
    });

    it("joins the open transaction when handed its handle, and rolls back with it", async () => {
        await expect(withTransaction(db, async tx => {
            await withTransaction(tx, async inner => { await inner.update(userTable).set({ version: NEW_VERSION }); });
            throw new Error("boom");
        })).rejects.toThrow("boom");

        expect(await userVersion()).toEqual(OLD_VERSION);
    });

    it("warns when a call waits on the transaction it was made from", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            let inner: Promise<void> | undefined;
            const outer = withTransaction(db, async () => {
                // The plain db, not the handle: this queues behind the transaction it is inside, and can never start.
                inner = withTransaction(db, async () => {});
                await vi.advanceTimersByTimeAsync(10_000);
            });
            await vi.advanceTimersByTimeAsync(0);
            await outer;
            await inner;

            expect(warn).toHaveBeenCalledWith(expect.stringContaining("plain db"));
        } finally {
            vi.useRealTimers();
        }
    });

    it("returns what the work returns", async () => {
        expect(await withTransaction(db, async () => 42)).toBe(42);
    });
});
