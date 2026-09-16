import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { enqueueSongRetag } from "@/app/services/db/queries/request";
import { requestTable, SongRetagPayload } from "@/app/services/db/schema";
import { RequestType } from "@/app/enums";
import { toRetagItems } from "@/app/services/sync-manager/syncLogic";

// In-memory SQLite mirroring the requests (outbox) table. Exercises the enqueue-time stronger-wins rule
// and the one-burst wire mapping — the two halves that make a mixed Keep/Like backlog flush correctly.
function makeDb(): GenericDb {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
        CREATE TABLE requests (
            request_id TEXT PRIMARY KEY, time_request INTEGER NOT NULL, request_type INTEGER NOT NULL,
            user_id TEXT NOT NULL, username TEXT, user_hash TEXT, song_id TEXT, playlist_id TEXT,
            last_played INTEGER, like_status INTEGER, payload TEXT
        );
    `);
    return drizzle(sqlite) as unknown as GenericDb;
}

async function retagRows(db: GenericDb) {
    return await db.select().from(requestTable).where(eq(requestTable.requestType, RequestType.SongRetag));
}

describe("enqueueSongRetag (one row per song, stronger-wins)", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("inserts a row carrying the model payload", async () => {
        await enqueueSongRetag(db, "u1", "s1", "weak");

        const rows = await retagRows(db);
        expect(rows).toHaveLength(1);
        expect((rows[0].payload as SongRetagPayload).model).toBe("weak");
        expect(rows[0].songId).toBe("s1");
    });

    it("Keep then Like upgrades the pending row weak -> strong (one row, one AI run)", async () => {
        await enqueueSongRetag(db, "u1", "s1", "weak");   // Keep
        await enqueueSongRetag(db, "u1", "s1", "strong"); // Like before the sync flushed

        const rows = await retagRows(db);
        expect(rows).toHaveLength(1);
        expect((rows[0].payload as SongRetagPayload).model).toBe("strong");
    });

    it("Like then Keep never downgrades", async () => {
        await enqueueSongRetag(db, "u1", "s1", "strong");
        await enqueueSongRetag(db, "u1", "s1", "weak");

        const rows = await retagRows(db);
        expect(rows).toHaveLength(1);
        expect((rows[0].payload as SongRetagPayload).model).toBe("strong");
    });

    it("distinct songs get their own rows", async () => {
        await enqueueSongRetag(db, "u1", "s1", "weak");
        await enqueueSongRetag(db, "u1", "s2", "strong");

        expect(await retagRows(db)).toHaveLength(2);
    });
});

describe("toRetagItems (one-burst wire mapping)", () => {
    it("maps rows to per-item {songId, model}", () => {
        const items = toRetagItems([
            { songId: "kept", payload: { model: "weak" } },
            { songId: "liked", payload: { model: "strong" } },
        ]);
        expect(items).toEqual([
            { songId: "kept", model: "weak" },
            { songId: "liked", model: "strong" },
        ]);
    });

    it("legacy rows without payload default to strong", () => {
        expect(toRetagItems([{ songId: "old" }])).toEqual([{ songId: "old", model: "strong" }]);
    });

    it("defensive dedupe collapses stronger-wins", () => {
        const items = toRetagItems([
            { songId: "s1", payload: { model: "weak" } },
            { songId: "s1", payload: { model: "strong" } },
            { songId: "s2", payload: { model: "strong" } },
            { songId: "s2", payload: { model: "weak" } },
        ]);
        expect(items).toEqual([
            { songId: "s1", model: "strong" },
            { songId: "s2", model: "strong" },
        ]);
    });

    it("skips rows without a songId", () => {
        expect(toRetagItems([{ songId: null }])).toEqual([]);
    });
});
