import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { GenericDb } from "@/app/services/db/GenericDb";
import {
    getCurrentlyPlayingSong,
    addRecentlyPlayedSong,
    resetRecentlyPlayedSongTimestamps,
    setRecentlyPlayedSongTimestampSeconds,
    checkForNextRecentlyPlayedSong,
    checkForLastRecentlyPlayedSong,
    markRecentlyPlayedSongCurrent,
} from "@/app/services/db/queries/recentlyPlayedSong";

/**
 * The play-history table decides what plays next before shuffle is ever consulted:
 *
 *     skip() -> checkForNextRecentlyPlayedSong() -> if it returns something, PLAY THAT
 *
 * so anything wrong in here repeats a song no matter how good the shuffle is. "Currently playing" is encoded
 * as "the row whose timestamp_seconds is not null", which is a fragile way to store a singleton: two writers
 * touch it (startNewSong resets + inserts, SongProgressSync writes progress every second), and nothing
 * enforces that only one row qualifies.
 */
function makeDb(): GenericDb {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
        CREATE TABLE recently_played_songs (
            recently_played_song_id TEXT PRIMARY KEY,
            song_id TEXT NOT NULL,
            timestamp_seconds INTEGER,
            last_played INTEGER NOT NULL
        );
    `);
    return drizzle(sqlite) as unknown as GenericDb;
}

/** Plays a song exactly the way startNewSong does: clear the marker, then insert the new row. */
async function play(db: GenericDb, id: string, songId: string, atMs: number) {
    await resetRecentlyPlayedSongTimestamps(db);
    await addRecentlyPlayedSong(db, {
        recentlyPlayedSongId: id,
        songId,
        timestampSeconds: 0,
        lastPlayed: new Date(atMs),
    });
}

describe("play history", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("reports the song that is actually playing", async () => {
        await play(db, "r1", "song-A", 1_000);
        await play(db, "r2", "song-B", 2_000);

        expect((await getCurrentlyPlayingSong(db))?.songId).toBe("song-B");
    });

    it("has nothing queued ahead during ordinary forward playback", async () => {
        // Nothing was played AFTER the current song, so shuffle should choose the next one.
        await play(db, "r1", "song-A", 1_000);
        await play(db, "r2", "song-B", 2_000);

        expect(await checkForNextRecentlyPlayedSong(db)).toBeUndefined();
    });

    it("walks backwards and forwards through history", async () => {
        await play(db, "r1", "song-A", 1_000);
        await play(db, "r2", "song-B", 2_000);
        await play(db, "r3", "song-C", 3_000);

        // Go back to B (what previous() does: re-mark an older row as current).
        await resetRecentlyPlayedSongTimestamps(db);
        await markRecentlyPlayedSongCurrent(db, "r2", 0);

        expect((await checkForLastRecentlyPlayedSong(db))?.songId).toBe("song-A");
        expect((await checkForNextRecentlyPlayedSong(db))?.songId).toBe("song-C");
    });

    it("picks the ADJACENT history entry, not just any of them", async () => {
        // Ordering inside checkForRecentlyPlayedSong is what makes previous/next mean anything; without it
        // "next" is an arbitrary row from the whole future of the history.
        for (let i = 1; i <= 6; i++) {
            await play(db, `r${i}`, `song-${i}`, i * 1_000);
        }
        await resetRecentlyPlayedSongTimestamps(db);
        await markRecentlyPlayedSongCurrent(db, "r3", 0);

        expect((await checkForNextRecentlyPlayedSong(db))?.songId).toBe("song-4");
        expect((await checkForLastRecentlyPlayedSong(db))?.songId).toBe("song-2");
    });

    // ── resume must still work ──────────────────────────────────────────────────────────────────────

    it("resuming an older song still makes it current", async () => {
        // The fix must not break the thing it protects. startNewSong clears every marker BEFORE the resume
        // branch writes, so resume needs a call that can set a marker on a cleared row - guarding that one too
        // would leave nothing current at all, which is worse than the repeat.
        await play(db, "r1", "song-A", 1_000);
        await play(db, "r2", "song-B", 2_000);

        await resetRecentlyPlayedSongTimestamps(db);
        await markRecentlyPlayedSongCurrent(db, "r1", 30);

        const current = await getCurrentlyPlayingSong(db);
        expect(current?.songId).toBe("song-A");
        expect(current?.timestampSeconds).toBe(30);
    });

    it("a progress tick cannot make a cleared row current", async () => {
        await play(db, "r1", "song-A", 1_000);
        await resetRecentlyPlayedSongTimestamps(db);

        // This is the stale tick, arriving after the marker was cleared.
        await setRecentlyPlayedSongTimestampSeconds(db, "r1", 99);

        expect(await getCurrentlyPlayingSong(db)).toBeUndefined();
    });

    // ── the repeat ──────────────────────────────────────────────────────────────────────────────────

    it("a late progress write cannot resurrect the previous song as 'current'", async () => {
        // SongProgressSync ticks once a second: it reads the current row, then writes its position. On the
        // async (desktop) driver every step is a round-trip to the OPFS worker, so a track change can land in
        // between - and the write then re-marks the song that just finished as current.
        await play(db, "r1", "song-A", 1_000);

        // ...tick reads r1 here...
        await play(db, "r2", "song-B", 2_000);   // A ends, B starts
        await setRecentlyPlayedSongTimestampSeconds(db, "r1", 42);   // ...and the stale write lands

        expect((await getCurrentlyPlayingSong(db))?.songId).toBe("song-B");
    });

    it("never offers the currently playing song as the next one", async () => {
        // This is the actual bug: with A resurrected, "current" reads as A, so "the next song after A" is B -
        // the song already playing. It gets played a second time in a row.
        await play(db, "r1", "song-A", 1_000);
        await play(db, "r2", "song-B", 2_000);
        await setRecentlyPlayedSongTimestampSeconds(db, "r1", 42);

        const next = await checkForNextRecentlyPlayedSong(db);
        expect(next?.songId).not.toBe("song-B");
    });

    it("survives a burst of stale progress writes without repeating", async () => {
        // Several ticks can be in flight at once when the worker is slow.
        await play(db, "r1", "song-A", 1_000);
        await play(db, "r2", "song-B", 2_000);
        for (const seconds of [10, 20, 30]) {
            await setRecentlyPlayedSongTimestampSeconds(db, "r1", seconds);
        }

        expect((await getCurrentlyPlayingSong(db))?.songId).toBe("song-B");
        expect(await checkForNextRecentlyPlayedSong(db)).toBeUndefined();
    });

    it("keeps progress writes working for the song that IS playing", async () => {
        // The guard must not break the feature it protects: resume position still has to persist.
        await play(db, "r1", "song-A", 1_000);
        await setRecentlyPlayedSongTimestampSeconds(db, "r1", 75);

        const current = await getCurrentlyPlayingSong(db);
        expect(current?.songId).toBe("song-A");
        expect(current?.timestampSeconds).toBe(75);
    });
});
