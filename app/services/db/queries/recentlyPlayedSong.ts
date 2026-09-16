import { GenericDb } from "../GenericDb";
import { RecentlyPlayedSong } from "../models";
import { recentlyPlayedSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

/**
 * The song playing right now: the history row still carrying a timestamp, NEWEST first, one row.
 *
 * "Currently playing" is stored as "timestamp_seconds is not null" - a singleton this table cannot enforce.
 * Two writers touch it: startNewSong clears every marker then inserts the new row, while SongProgressSync
 * writes the position every second using a row id it read several awaits earlier. A progress write that lands
 * just after a track change therefore re-marks the song that already finished, and two rows claim to be current.
 *
 * This used to take result[0] of an UNORDERED query, which in that state returned the finished song. skip()
 * then asked "what was played after that?", got the song already playing, and played it a second time in a row.
 * Ordering by lastPlayed makes the newest marker authoritative, so a stale one is harmless instead of a repeat.
 */
export async function getCurrentlyPlayingSong(db: GenericDb): Promise<RecentlyPlayedSong | undefined> {
    const result = await db
        .select()
        .from(recentlyPlayedSongTable)
        .where(isNotNull(recentlyPlayedSongTable.timestampSeconds))
        .orderBy(desc(recentlyPlayedSongTable.lastPlayed))
        .limit(1);

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

export async function getRecentlyPlayedSong(db: GenericDb, recentlyPlayedSongId: string): Promise<RecentlyPlayedSong | undefined> {
    const result = await db.select().from(recentlyPlayedSongTable).where(eq(recentlyPlayedSongTable.recentlyPlayedSongId, recentlyPlayedSongId));

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

export async function resetRecentlyPlayedSongTimestamps(db: GenericDb): Promise<void> {
    await db.update(recentlyPlayedSongTable).set({
        timestampSeconds: null
    }).where(isNotNull(recentlyPlayedSongTable.timestampSeconds));
}

/**
 * Records playback POSITION on the song already playing.
 *
 * Deliberately cannot make a row current: it only updates one whose marker is already set. SongProgressSync
 * reads the current row and writes its position several awaits later - an eternity on the async desktop
 * driver - so without this a write arriving after a track change would re-mark the finished song as current
 * and get it played again. startNewSong clears every marker before starting the next song, so a superseded
 * row is null by then and the stale write correctly does nothing.
 *
 * Starting or resuming a song uses <see cref="markRecentlyPlayedSongCurrent"/> instead, because that legitimately
 * needs to set the marker.
 */
export async function setRecentlyPlayedSongTimestampSeconds(db: GenericDb, recentlyPlayedSongId: string, timestampSeconds: number): Promise<void> {
    await db.update(recentlyPlayedSongTable).set({
        timestampSeconds: timestampSeconds
    }).where(and(
        eq(recentlyPlayedSongTable.recentlyPlayedSongId, recentlyPlayedSongId),
        isNotNull(recentlyPlayedSongTable.timestampSeconds)
    ));
}

/**
 * Makes an existing history row the current song, at the given position - the resume path (previous(), or
 * restoring what was playing at startup). Unguarded on purpose: startNewSong clears all markers first, so this
 * is the call that legitimately sets one. Progress ticks must NOT use it, or a late tick would resurrect a
 * song that has already finished.
 */
export async function markRecentlyPlayedSongCurrent(db: GenericDb, recentlyPlayedSongId: string, timestampSeconds: number): Promise<void> {
    await db.update(recentlyPlayedSongTable).set({
        timestampSeconds: timestampSeconds
    }).where(eq(recentlyPlayedSongTable.recentlyPlayedSongId, recentlyPlayedSongId));
}

export async function addRecentlyPlayedSong(db: GenericDb, recentlyPlayedSong: RecentlyPlayedSong): Promise<void> {
    await db.insert(recentlyPlayedSongTable).values([recentlyPlayedSong]);
}

export async function getRecentlyPlayedSongs(db: GenericDb): Promise<RecentlyPlayedSong[]> {
    return await db.select()
        .from(recentlyPlayedSongTable)
        .orderBy(recentlyPlayedSongTable.lastPlayed);
}

export async function removeAllRecentlyPlayedSongs(db: GenericDb): Promise<void> {
    await db.delete(recentlyPlayedSongTable);
}

export async function removeRecentlyPlayedSongsAfter(db: GenericDb, date: Date): Promise<void> {
    await db.delete(recentlyPlayedSongTable).where(gt(recentlyPlayedSongTable.lastPlayed, date));
}

export async function checkForLastRecentlyPlayedSong(db: GenericDb): Promise<RecentlyPlayedSong | undefined> {
    return await checkForRecentlyPlayedSong(db, false);
}

export async function checkForNextRecentlyPlayedSong(db: GenericDb): Promise<RecentlyPlayedSong | undefined> {
    return await checkForRecentlyPlayedSong(db, true);
}

export async function checkForRecentlyPlayedSong(db: GenericDb, next: boolean): Promise<RecentlyPlayedSong | undefined> {
    const currentlyPlayingSong = await getCurrentlyPlayingSong(db);

    if (currentlyPlayingSong == undefined) {
        return undefined;
    }

    let query = db
        .select()
        .from(recentlyPlayedSongTable)
        .where(next ? gt(recentlyPlayedSongTable.lastPlayed, currentlyPlayingSong.lastPlayed) : lt(recentlyPlayedSongTable.lastPlayed, currentlyPlayingSong.lastPlayed));

    if (next) {
        query.orderBy(recentlyPlayedSongTable.lastPlayed);
    } else {
        query.orderBy(sql`${recentlyPlayedSongTable.lastPlayed} DESC`);
    }

    const result = await query.limit(1);

    if (!result.length) {
        return undefined;
    }

    return result[0];
}