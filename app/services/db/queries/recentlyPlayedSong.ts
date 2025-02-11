import { GenericDb } from "../GenericDb";
import { RecentlyPlayedSong } from "../models";
import { recentlyPlayedSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function getCurrentlyPlayingSong(db: GenericDb): Promise<RecentlyPlayedSong | undefined> {
    const result = await db.select().from(recentlyPlayedSongTable).where(isNotNull(recentlyPlayedSongTable.timestampSeconds));

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

export async function getRecentlyPlayedSong(db: GenericDb, recentlyPlayedSongGuid: string): Promise<RecentlyPlayedSong | undefined> {
    const result = await db.select().from(recentlyPlayedSongTable).where(eq(recentlyPlayedSongTable.recentlyPlayedSongGuid, recentlyPlayedSongGuid));

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

export async function setRecentlyPlayedSongTimestampSeconds(db: GenericDb, recentlyPlayedSongGuid: string, timestampSeconds: number): Promise<void> {
    await db.update(recentlyPlayedSongTable).set({
        timestampSeconds: timestampSeconds
    }).where(eq(recentlyPlayedSongTable.recentlyPlayedSongGuid, recentlyPlayedSongGuid));
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