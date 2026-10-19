import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import os from "os";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { addRequests, deadLetterRequests, getDeadLetterRequests, getRequests } from "@/app/services/db/queries/request";
import { addGenreJam, getGenreJams } from "@/app/services/db/queries/genreJam";
import { prepareDatabase, rebuildKeepingLocalData, restoreRescuedTables } from "@/app/services/db/recovery";
import { RequestType } from "@/app/enums";

/**
 * ShuffullApp#92: a migration that fails used to delete the database file outright, and the outbox with it —
 * queued Keeps, Likes and playlist deletes that exist nowhere else until they are sent — plus the dead letters
 * and the user's genre jams.
 *
 * These run against a real database FILE, so "the app was killed" can be shown by closing it and opening it again.
 */
const MIGRATIONS = path.resolve(__dirname, "../app/services/db/drizzle");

let dir: string;
let file: string;
let sqlite: Database.Database;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shuffull-92-"));
    file = path.join(dir, "shuffull-db");
    sqlite = new Database(file);
    deleteFile.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

// Native-shaped handle: raw `sql` rows come back as objects.
const asDb = (handle: Database.Database) => drizzle(handle) as unknown as GenericDb;

// Web-shaped handle: sqlite-proxy, whose raw rows are positional arrays (as the OPFS driver returns them).
// `refuse` makes matching statements fail, to stand in for a file too damaged to change.
function asProxyDb(handle: () => Database.Database, refuse?: RegExp): GenericDb {
    return drizzleProxy(async (query, params, method) => {
        if (refuse?.test(query)) {
            throw new Error("database disk image is malformed");
        }
        const statement = handle().prepare(query);
        if (method === "run") {
            statement.run(...params);
            return { rows: [] };
        }
        const rows = statement.raw().all(...params) as unknown[][];
        return { rows: method === "get" ? (rows[0] ?? []) : rows };
    }) as unknown as GenericDb;
}

// The migrations folder cut off after `lastTag`, for building a database on an older schema.
function migrationsUpTo(lastTag: string): string {
    const out = path.join(dir, "migrations");
    fs.mkdirSync(path.join(out, "meta"), { recursive: true });
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
    const end = journal.entries.findIndex((e: { tag: string }) => e.tag === lastTag);
    journal.entries = journal.entries.slice(0, end + 1);
    for (const entry of journal.entries) {
        fs.copyFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), path.join(out, `${entry.tag}.sql`));
    }
    fs.writeFileSync(path.join(out, "meta/_journal.json"), JSON.stringify(journal));
    return out;
}

// Migrates whatever file is open now. Async, so a failure arrives as a rejection the way it does on the device.
const migrateTo = (folder: string) => migrate(drizzle(sqlite), { migrationsFolder: folder });
const migrateLatest = async () => migrateTo(MIGRATIONS);

// What resetDb() does: close, delete the file, open a new empty one at the same path.
const deleteFile = vi.fn(() => {
    sqlite.close();
    fs.rmSync(file);
    sqlite = new Database(file);
    return asDb(sqlite);
});

// Close and reopen the file, as an app restart would.
function restart(): GenericDb {
    sqlite.close();
    sqlite = new Database(file);
    return asDb(sqlite);
}

const rescued = () => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_\\_rescued\\_%' ESCAPE '\\'")
    .all() as { name: string }[]).map((x) => x.name);

const keep = {
    requestId: "keep-1",
    timeRequested: new Date("2026-10-01T00:00:00Z"),
    requestType: RequestType.SongRetag,
    userId: "u1",
    songId: "s1",
    payload: { model: "weak" as const },
};
const deletePlaylist = {
    requestId: "delete-1",
    timeRequested: new Date("2026-10-01T00:01:00Z"),
    requestType: RequestType.DeletePlaylist,
    userId: "u1",
    playlistId: "p1",
    payload: { songIds: ["s1", "s2"] },
};
const jam = {
    genreJamId: "jam-1",
    name: "Morning",
    whitelists: { artistIds: ["a1"], playlistIds: [], genreIds: [], timePeriodIds: [], languageIds: [], moodIds: [], themeIds: [] },
    blacklists: { artistIds: [], playlistIds: [], genreIds: [], timePeriodIds: [], languageIds: [], moodIds: [], themeIds: [] },
    energyMin: 3,
    energyMax: 7,
};

// A Keep written by hand on an older schema, which the app's queries can't write to.
function insertOldKeep() {
    sqlite.prepare(`INSERT INTO requests (request_id, time_request, request_type, user_id, song_id, payload)
                    VALUES ('keep-1', ?, ?, 'u1', 's1', '{"model":"weak"}')`).run(keep.timeRequested.getTime(), keep.requestType);
}

describe("a failed migration rebuilds the database and keeps the data only this device has", () => {
    it("outbox, dead letters and genre jams survive; the server cache is dropped", async () => {
        const db = asDb(sqlite);
        await migrateLatest();
        await addRequests(db, [keep, deletePlaylist]);
        await addRequests(db, [{ ...keep, requestId: "keep-2", songId: "s9" }]);
        await deadLetterRequests(db, [{ request: { ...keep, requestId: "keep-2", songId: "s9" }, reason: "not in your library" }]);
        await addGenreJam(db, jam);
        sqlite.exec("INSERT INTO users (user_id, username, version) VALUES ('u1', 'max', 0)");

        const fresh = await rebuildKeepingLocalData(db, migrateLatest, deleteFile);

        expect(deleteFile).not.toHaveBeenCalled();
        expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
        // Read back through the app's own queries: dates, JSON payloads and every column intact.
        expect(await getRequests(fresh)).toEqual([expect.objectContaining(keep), expect.objectContaining(deletePlaylist)]);
        const dead = await getDeadLetterRequests(fresh, "u1");
        expect(dead).toHaveLength(1);
        expect(dead[0]).toMatchObject({ requestId: "keep-2", songId: "s9", reason: "not in your library" });
        expect(dead[0].request).toMatchObject({ requestId: "keep-2", songId: "s9" });
        expect(await getGenreJams(fresh)).toEqual([expect.objectContaining(jam)]);
        expect(rescued()).toEqual([]);
    });

    it("a stale on-device schema that fails to migrate is rebuilt with its queued Keep", async () => {
        // On the schema before 0027, with the column 0027 adds already present: migrating fails on
        // "duplicate column name", the kind of drift that sent devices through the reset.
        const db = asDb(sqlite);
        migrateTo(migrationsUpTo("0026_add_exploratory_flags"));
        sqlite.exec("ALTER TABLE requests ADD playlist_id text");
        insertOldKeep();

        await expect(migrateLatest()).rejects.toThrow(/ADD `playlist_id`/);
        const fresh = await rebuildKeepingLocalData(db, migrateLatest, deleteFile);

        expect(await getRequests(fresh)).toEqual([expect.objectContaining(keep)]);
    });

    it("copies the columns both schemas share; a column the old one lacked takes its default", async () => {
        const db = asDb(sqlite);
        migrateTo(migrationsUpTo("0026_add_exploratory_flags"));
        insertOldKeep();

        const fresh = await rebuildKeepingLocalData(db, migrateLatest, deleteFile);

        const [row] = await getRequests(fresh);
        expect(row).toMatchObject(keep);
        expect(row.playlistId).toBeNull();
    });

    it("works on the web driver, whose raw rows are arrays rather than objects", async () => {
        const db = asProxyDb(() => sqlite);
        await migrateLatest();
        await addRequests(db, [keep, deletePlaylist]);

        const fresh = await rebuildKeepingLocalData(db, migrateLatest, deleteFile);

        expect(await getRequests(fresh)).toEqual([expect.objectContaining(keep), expect.objectContaining(deletePlaylist)]);
        expect(rescued()).toEqual([]);
    });

    it("a schema from before the outbox existed rebuilds with nothing to carry", async () => {
        const db = asDb(sqlite);
        migrateTo(migrationsUpTo("0007_add_notnull_req"));

        const fresh = await rebuildKeepingLocalData(db, migrateLatest, deleteFile);

        expect(await getRequests(fresh)).toEqual([]);
        expect(rescued()).toEqual([]);
    });
});

describe("the preserved rows are never only in memory", () => {
    it("if the rebuild dies before restoring, the rows are still in the file, and the next start restores them", async () => {
        const db = asDb(sqlite);
        await migrateLatest();
        await addRequests(db, [keep]);
        await addGenreJam(db, jam);

        await expect(rebuildKeepingLocalData(db, async () => { throw new Error("killed mid-migration"); }, deleteFile))
            .rejects.toThrow("killed mid-migration");
        expect(rescued()).toHaveLength(3); // requests, dead_letter_requests (empty) and genre_jam

        // Next launch: the provider migrates (now it works) and restores whatever is rescued.
        const next = restart();
        await migrateLatest();
        await restoreRescuedTables(next);

        expect(await getRequests(next)).toEqual([expect.objectContaining(keep)]);
        expect(await getGenreJams(next)).toEqual([expect.objectContaining(jam)]);
        expect(rescued()).toEqual([]);
    });

    it("a row that fits neither the outbox nor the dead letters stays rescued and is retried on every start", async () => {
        const db = asDb(sqlite);
        // A hand-made requests table where one row has no user_id, which the new table requires.
        sqlite.exec("CREATE TABLE requests (request_id text PRIMARY KEY, time_request integer, request_type integer, user_id text)");
        sqlite.exec(`INSERT INTO requests VALUES ('good', 1, ${RequestType.SongRetag}, 'u1'), ('orphan', 2, ${RequestType.SongRetag}, NULL)`);

        const fresh = await rebuildKeepingLocalData(db, migrateLatest, deleteFile);

        expect((await getRequests(fresh)).map((x) => x.requestId)).toEqual(["good"]);
        const [table] = rescued();
        expect(sqlite.prepare(`SELECT request_id FROM "${table}"`).all()).toEqual([{ request_id: "orphan" }]);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("1 row(s) could not be restored"), expect.anything());

        expect(await restoreRescuedTables(restart())).toEqual({ restored: 0, deadLettered: 0, leftInPlace: [table] });
        expect(rescued()).toEqual([table]);
    });

    it("only a file too damaged to change falls back to deleting it, and says what that lost", async () => {
        const db = asProxyDb(() => sqlite, /^ALTER TABLE/);
        await migrateLatest();
        await addRequests(db, [keep]);

        const fresh = await rebuildKeepingLocalData(db, migrateLatest, deleteFile);

        expect(deleteFile).toHaveBeenCalledOnce();
        expect(await getRequests(fresh)).toEqual([]);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("are lost"), expect.anything());
    });

    it("with nothing rescued, the start-up check does nothing", async () => {
        await migrateLatest();
        expect(await restoreRescuedTables(asDb(sqlite))).toEqual({ restored: 0, deadLettered: 0, leftInPlace: [] });
    });

    it("an outbox row the new schema refuses is dead-lettered with the reason, so the delete hold sees it", async () => {
        const db = asDb(sqlite);
        await migrateLatest();
        await addRequests(db, [keep, { ...keep, requestId: "keep-2", songId: "s9" }]);
        // Stands in for a later schema that no longer accepts this row.
        const migrateRefusingS9 = async () => {
            await migrateLatest();
            sqlite.exec(`CREATE TRIGGER refuse_s9 BEFORE INSERT ON requests WHEN NEW.song_id = 's9'
                         BEGIN SELECT RAISE(ABORT, 'song_id s9 no longer fits'); END`);
        };

        const fresh = await rebuildKeepingLocalData(db, migrateRefusingS9, deleteFile);

        expect((await getRequests(fresh)).map((x) => x.requestId)).toEqual(["keep-1"]);
        const [dead] = await getDeadLetterRequests(fresh, "u1");
        expect(dead).toMatchObject({ requestId: "keep-2", requestType: RequestType.SongRetag, songId: "s9" });
        expect(dead.reason).toContain("song_id s9 no longer fits");
        expect(dead.request).toMatchObject({ requestId: "keep-2", songId: "s9", payload: { model: "weak" } });
        expect(rescued()).toEqual([]);
    });
});

describe("indexes on preserved tables", () => {
    it("don't collide with the ones the migrations recreate", async () => {
        // Index names are global and follow a table through a rename. Today no preserved table is indexed; the
        // first migration that indexes one must not brick every later rebuild with "index already exists".
        const db = asDb(sqlite);
        await migrateLatest();
        sqlite.exec("CREATE INDEX idx_requests_song ON requests (song_id)");
        await addRequests(db, [keep]);
        const migrateWithIndex = async () => {
            await migrateLatest();
            sqlite.exec("CREATE INDEX idx_requests_song ON requests (song_id)");
        };

        const fresh = await rebuildKeepingLocalData(db, migrateWithIndex, deleteFile);

        expect(await getRequests(fresh)).toEqual([expect.objectContaining(keep)]);
    });
});

describe("prepareDatabase (what both providers run on start)", () => {
    it("a normal start migrates and finishes a rebuild a crash left behind", async () => {
        const db = asDb(sqlite);
        await migrateLatest();
        await addRequests(db, [keep]);
        await expect(rebuildKeepingLocalData(db, async () => { throw new Error("killed"); }, deleteFile)).rejects.toThrow();

        const next = await prepareDatabase(restart(), migrateLatest, deleteFile);

        expect(await getRequests(next)).toEqual([expect.objectContaining(keep)]);
        expect(rescued()).toEqual([]);
    });

    it("a migration failure goes through the rebuild and keeps the outbox", async () => {
        const db = asDb(sqlite);
        migrateTo(migrationsUpTo("0026_add_exploratory_flags"));
        sqlite.exec("ALTER TABLE requests ADD playlist_id text");
        insertOldKeep();

        const next = await prepareDatabase(db, migrateLatest, deleteFile);

        expect(deleteFile).not.toHaveBeenCalled();
        expect(await getRequests(next)).toEqual([expect.objectContaining(keep)]);
    });

    it("throws only if the rebuilt database can't be migrated either", async () => {
        await expect(prepareDatabase(asDb(sqlite), async () => { throw new Error("broken bundle"); }, deleteFile))
            .rejects.toThrow("broken bundle");
    });
});
