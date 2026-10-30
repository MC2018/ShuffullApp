import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, sql } from "drizzle-orm";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { addRequests, enqueueSongRetag, getRequests } from "@/app/services/db/queries/request";
import { recordKeep, recordLikeStatus } from "@/app/services/db/queries/decision";
import { songTable, userSongTable, userTable } from "@/app/services/db/schema";
import { LikeStatus, RequestType } from "@/app/enums";
import { SYNC_MAX_BACKOFF_TICKS, syncTicksToSkip } from "@/app/services/sync-manager/syncLogic";

const USER = "u1";

function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

async function addSong(db: GenericDb, songId: string, flags: { exploratory?: boolean; tagsStale?: boolean } = {}) {
    await db.insert(songTable).values({ songId, name: songId, fileExtension: "mp3", fileHash: `hash-${songId}`, ...flags });
}

async function song(db: GenericDb, songId: string) {
    const [row] = await db.select().from(songTable).where(eq(songTable.songId, songId));
    return row;
}

// Makes every outbox insert fail, the way a full disk or a broken row would.
async function breakOutbox(db: GenericDb) {
    await db.run(sql`create trigger refuse_requests before insert on requests begin select raise(abort, 'outbox refused'); end`);
}

describe("getRequests: one user's outbox, in the order the user acted", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("returns rows oldest first, whatever order they were written in", async () => {
        const at = (ms: number) => new Date(1_700_000_000_000 + ms);
        await addRequests(db, [
            { requestId: "unlike", timeRequested: at(2), requestType: RequestType.SetSongLikeStatus, userId: USER, songId: "s1", likeStatus: LikeStatus.Neutral },
            { requestId: "like", timeRequested: at(1), requestType: RequestType.SetSongLikeStatus, userId: USER, songId: "s1", likeStatus: LikeStatus.Like },
        ]);

        expect((await getRequests(db, USER)).map(x => x.requestId)).toEqual(["like", "unlike"]);
    });

    it("keeps rows queued in the same millisecond in the order they were written", async () => {
        const now = new Date();
        const ids = ["c", "a", "b"];
        for (const requestId of ids) {
            await addRequests(db, [{ requestId, timeRequested: now, requestType: RequestType.CreateUserSong, userId: USER, songId: requestId }]);
        }

        expect((await getRequests(db, USER)).map(x => x.requestId)).toEqual(ids);
    });

    it("leaves out another account's rows", async () => {
        await enqueueSongRetag(db, USER, "mine", "weak");
        await enqueueSongRetag(db, "someone-else", "theirs", "weak");

        expect((await getRequests(db, USER)).map(x => x.songId)).toEqual(["mine"]);
    });
});

describe("enqueueSongRetag: an upgrade is a new row, so a flush in flight can't delete it", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("replaces a weak row with a strong one under a new id, at the original time", async () => {
        await enqueueSongRetag(db, USER, "s1", "weak");
        const [weak] = await getRequests(db, USER);

        await enqueueSongRetag(db, USER, "s1", "strong");

        const rows = await getRequests(db, USER);
        expect(rows).toHaveLength(1);
        expect(rows[0].requestId).not.toBe(weak.requestId);
        expect(rows[0].payload).toEqual({ model: "strong" });
        expect(rows[0].timeRequested).toEqual(weak.timeRequested);
    });

    it("never downgrades, and leaves the row alone", async () => {
        await enqueueSongRetag(db, USER, "s1", "strong");
        const before = await getRequests(db, USER);

        await enqueueSongRetag(db, USER, "s1", "weak");

        expect(await getRequests(db, USER)).toEqual(before);
    });

    it("keeps one row per song per user, not per song", async () => {
        await enqueueSongRetag(db, "someone-else", "s1", "weak");
        await enqueueSongRetag(db, USER, "s1", "weak");

        expect(await getRequests(db, USER)).toHaveLength(1);
        expect(await getRequests(db, "someone-else")).toHaveLength(1);
    });
});

describe("recordLikeStatus / recordKeep: the decision and its outbox row commit together", () => {
    let db: GenericDb;
    beforeEach(async () => {
        db = makeDb();
        await db.insert(userTable).values({ userId: USER, username: "max", version: new Date(), isCurator: false });
    });

    it("a Like of an audition song saves the rating, queues it and a strong re-tag, and promotes the song", async () => {
        await addSong(db, "s1", { exploratory: true });

        const { song: before, promoted } = await recordLikeStatus(db, USER, "s1", LikeStatus.Like);

        expect(before?.exploratory).toBe(true);
        expect(promoted).toBe(true);
        const [userSong] = await db.select().from(userSongTable);
        expect(userSong.likeStatus).toBe(LikeStatus.Like);
        expect((await getRequests(db, USER)).map(x => [x.requestType, x.payload ?? x.likeStatus])).toEqual([
            [RequestType.SetSongLikeStatus, LikeStatus.Like],
            [RequestType.SongRetag, { model: "strong" }],
        ]);
        expect(await song(db, "s1")).toMatchObject({ exploratory: false, tagsStale: false });
    });

    it("a Like whose outbox row can't be written leaves no rating and no promotion behind", async () => {
        await addSong(db, "s1", { exploratory: true });
        await breakOutbox(db);

        await expect(recordLikeStatus(db, USER, "s1", LikeStatus.Like)).rejects.toThrow("outbox refused");

        expect(await db.select().from(userSongTable)).toEqual([]);
        expect(await song(db, "s1")).toMatchObject({ exploratory: true });
    });

    it("a Keep queues a weak re-tag and marks the song kept", async () => {
        await addSong(db, "s1", { exploratory: true });

        expect(await recordKeep(db, USER, "s1")).toBe(true);

        expect((await getRequests(db, USER)).map(x => x.payload)).toEqual([{ model: "weak" }]);
        expect(await song(db, "s1")).toMatchObject({ exploratory: false, tagsStale: true });
    });

    it("a Keep whose outbox row can't be written leaves the song an audition song", async () => {
        await addSong(db, "s1", { exploratory: true });
        await breakOutbox(db);

        await expect(recordKeep(db, USER, "s1")).rejects.toThrow("outbox refused");

        expect(await song(db, "s1")).toMatchObject({ exploratory: true, tagsStale: false });
    });

    it("a Keep of a song that isn't an audition song writes nothing", async () => {
        await addSong(db, "s1");

        expect(await recordKeep(db, USER, "s1")).toBe(false);

        expect(await getRequests(db, USER)).toEqual([]);
    });
});

describe("syncTicksToSkip", () => {
    it("retries on the next tick after one failure, then doubles the gap up to the cap", () => {
        // The gap between tries is (skipped + 1) ticks: 10 s, 10 s, 20 s, 40 s, 80 s, 160 s, then 300 s.
        expect([0, 1, 2, 3, 4, 5, 6].map(syncTicksToSkip)).toEqual([0, 0, 1, 3, 7, 15, 29]);
        expect(syncTicksToSkip(100)).toBe(SYNC_MAX_BACKOFF_TICKS - 1);
    });
});
