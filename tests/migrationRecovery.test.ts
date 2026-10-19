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
import { rebuildKeepingOutbox, saveOutbox } from "@/app/services/db/recovery";
import { RequestType } from "@/app/enums";

/**
 * ShuffullApp#92: a migration that fails used to delete the database file outright, and the outbox with it —
 * queued Keeps, Likes and playlist deletes that exist nowhere else until they are sent.
 *
 * These run against a real database FILE, and `reset` really deletes it, the way `resetDb()` does on the device.
 */
const MIGRATIONS = path.resolve(__dirname, "../app/services/db/drizzle");

let dir: string;
let file: string;
let sqlite: Database.Database;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shuffull-92-"));
    file = path.join(dir, "shuffull-db");
    sqlite = new Database(file);
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
function asProxyDb(handle: () => Database.Database): GenericDb {
    return drizzleProxy(async (query, params, method) => {
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

// What resetDb() does: close, delete the file, open a new empty one at the same path.
function reset(wrap: (handle: Database.Database) => GenericDb = asDb) {
    return () => {
        sqlite.close();
        fs.rmSync(file);
        sqlite = new Database(file);
        return wrap(sqlite);
    };
}

// Migrates whatever file is open now. Async, so a failure arrives as a rejection the way it does on the device.
const migrateTo = (folder: string) => migrate(drizzle(sqlite), { migrationsFolder: folder });
const migrateLatest = async () => migrateTo(MIGRATIONS);

const keep = {
    requestId: "keep-1",
    timeRequested: new Date("2026-10-01T00:00:00Z"),
    requestType: RequestType.SongRetag,
    userId: "u1",
    songId: "s1",
};
const deletePlaylist = {
    requestId: "delete-1",
    timeRequested: new Date("2026-10-01T00:01:00Z"),
    requestType: RequestType.DeletePlaylist,
    userId: "u1",
    playlistId: "p1",
    payload: { songIds: ["s1", "s2"] },
};

describe("a forced migration failure keeps the outbox", () => {
    it("queued and dead-lettered rows survive the database being deleted and rebuilt", async () => {
        const db = asDb(sqlite);
        await migrateLatest();
        await addRequests(db, [keep, deletePlaylist]);
        await addRequests(db, [{ ...keep, requestId: "keep-2", songId: "s9" }]);
        await deadLetterRequests(db, [{ request: { ...keep, requestId: "keep-2", songId: "s9" }, reason: "not in your library" }]);
        // Something else in the file — a cached song row — which the rebuild is allowed to drop.
        sqlite.exec("INSERT INTO users (user_id, username, version) VALUES ('u1', 'max', 0)");

        const { db: fresh, outbox } = await rebuildKeepingOutbox(db, reset(), migrateLatest);

        expect(outbox).toEqual({ restored: 3, lost: [] });
        expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
        // Read back through the app's own queries: dates, JSON payloads and every column intact.
        expect(await getRequests(fresh)).toEqual([
            expect.objectContaining(keep),
            expect.objectContaining(deletePlaylist),
        ]);
        const dead = await getDeadLetterRequests(fresh, "u1");
        expect(dead).toHaveLength(1);
        expect(dead[0]).toMatchObject({ requestId: "keep-2", songId: "s9", reason: "not in your library" });
        expect(dead[0].request).toMatchObject({ requestId: "keep-2", songId: "s9" });
    });

    it("a stale on-device schema that fails to migrate is rebuilt with its queued Keep", async () => {
        // On the schema before 0027, with the column 0027 adds already present: migrating fails on
        // "duplicate column name", the kind of drift that sent devices through the reset.
        const db = asDb(sqlite);
        migrateTo(migrationsUpTo("0026_add_exploratory_flags"));
        sqlite.exec("ALTER TABLE requests ADD playlist_id text");
        sqlite.prepare(`INSERT INTO requests (request_id, time_request, request_type, user_id, song_id, playlist_id)
                        VALUES ('keep-1', ?, ?, 'u1', 's1', NULL)`).run(keep.timeRequested.getTime(), keep.requestType);

        await expect(migrateLatest()).rejects.toThrow(/ADD `playlist_id`/);

        const { db: fresh, outbox } = await rebuildKeepingOutbox(db, reset(), migrateLatest);

        expect(outbox.restored).toBe(1);
        expect(await getRequests(fresh)).toEqual([expect.objectContaining(keep)]);
    });

    it("copies the columns both schemas share; a column the old one lacked takes its default", async () => {
        const db = asDb(sqlite);
        migrateTo(migrationsUpTo("0026_add_exploratory_flags"));
        sqlite.prepare(`INSERT INTO requests (request_id, time_request, request_type, user_id, song_id)
                        VALUES ('keep-1', ?, ?, 'u1', 's1')`).run(keep.timeRequested.getTime(), keep.requestType);

        const { db: fresh } = await rebuildKeepingOutbox(db, reset(), migrateLatest);

        const [row] = await getRequests(fresh);
        expect(row).toMatchObject(keep);
        expect(row.playlistId).toBeNull();
    });

    it("works on the web driver, whose raw rows are arrays rather than objects", async () => {
        const db = asProxyDb(() => sqlite);
        await migrateLatest();
        await addRequests(db, [keep, deletePlaylist]);

        const saved = await saveOutbox(db);
        expect(saved.find((t) => t.table === "requests")?.rows[0]).toMatchObject({ request_id: "keep-1", song_id: "s1" });

        const { db: fresh, outbox } = await rebuildKeepingOutbox(
            db,
            reset(() => asProxyDb(() => sqlite)),
            migrateLatest,
        );

        expect(outbox).toEqual({ restored: 2, lost: [] });
        expect(await getRequests(fresh)).toEqual([
            expect.objectContaining(keep),
            expect.objectContaining(deletePlaylist),
        ]);
    });

    it("a schema from before the outbox existed rebuilds with nothing to carry", async () => {
        const db = asDb(sqlite);
        migrateTo(migrationsUpTo("0007_add_notnull_req"));

        const { db: fresh, outbox } = await rebuildKeepingOutbox(db, reset(), migrateLatest);

        expect(outbox).toEqual({ restored: 0, lost: [] });
        expect(await getRequests(fresh)).toEqual([]);
    });

    it("a row the rebuilt table can't take is reported and logged, and the rest still restore", async () => {
        const db = asDb(sqlite);
        // A hand-made requests table missing user_id, which the rebuilt one requires (NOT NULL, no default).
        sqlite.exec("CREATE TABLE requests (request_id text PRIMARY KEY, time_request integer, request_type integer)");
        sqlite.exec(`INSERT INTO requests VALUES ('orphan', 1, ${RequestType.SongRetag})`);

        const { outbox } = await rebuildKeepingOutbox(db, reset(), migrateLatest);

        expect(outbox.restored).toBe(0);
        expect(outbox.lost).toEqual([
            expect.objectContaining({ table: "requests", row: expect.objectContaining({ request_id: "orphan" }) }),
        ]);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Outbox row lost"), expect.stringContaining("orphan"));
    });

    it("if the rebuild itself fails, the carried rows are logged before the error surfaces", async () => {
        const db = asDb(sqlite);
        await migrateLatest();
        await addRequests(db, [keep]);

        await expect(rebuildKeepingOutbox(db, reset(), async () => { throw new Error("broken bundle"); }))
            .rejects.toThrow("broken bundle");
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("rebuild failed"), expect.stringContaining("keep-1"));
    });
});
