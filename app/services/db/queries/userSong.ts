import { GenericDb } from "../GenericDb";
import { UserSong } from "../models";
import { userSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { getActiveLocalSessionData } from "./localSessionData";
import { chunkIds, chunkRows } from "./_chunk";

export async function updateUserSongs(db: GenericDb, userSongs: UserSong[]): Promise<void> {
    const localSessionData = await getActiveLocalSessionData(db);

    if (!localSessionData) {
        throw new Error("Local session data is undefined while updating user songs.");
    }

    // Every list here scales with the sync payload, so each statement is chunked — an unsplit sync of ~1400
    // user songs is what first broke the desktop build. See _chunk.ts.
    const localUserSongs: UserSong[] = [];
    for (const idChunk of chunkIds(userSongs.map(x => x.songId))) {
        localUserSongs.push(...await db
            .select()
            .from(userSongTable)
            .where(
                and(
                    eq(userSongTable.userId, localSessionData.userId),
                    inArray(userSongTable.songId, idChunk)
                )
            ));
    }
    const localuserSongIds = localUserSongs.map(x => x.songId);

    for (const idChunk of chunkIds(localuserSongIds)) {
        await db.delete(userSongTable).where(inArray(userSongTable.songId, idChunk));
    }

    for (const rowChunk of chunkRows(userSongs)) {
        await db.insert(userSongTable).values(rowChunk);
    }
}

export async function updateUserSongLastPlayed(db: GenericDb, userId: string, songId: string, lastPlayed: Date): Promise<void> {
    await db.update(userSongTable).set({
        lastPlayed: lastPlayed
    }).where(and(eq(userSongTable.userId, userId), eq(userSongTable.songId, songId)));
}

export async function getUserSong(db: GenericDb, userId: string, songId: string) {
    const userSong = await db.select().from(userSongTable).where(and(eq(userSongTable.userId, userId), eq(userSongTable.songId, songId)));

    if (!userSong.length) {
        return undefined;
    }

    return userSong[0];
}

export async function addUserSong(db: GenericDb, userSong: UserSong): Promise<void> {
    await db.insert(userSongTable).values([userSong]);
}

// Optimistic local set of a song's like status for a user; upserts a UserSong row (the SITE requires one
// to exist, but the playing song always does). Bumps version so it survives until the next pull confirms it.
// Callers queue the matching SetSongLikeStatus request (DbQueries.addRequests) for the sync push.
export async function setUserSongLikeStatus(db: GenericDb, userId: string, songId: string, likeStatus: number): Promise<void> {
    const now = new Date();
    const existing = await getUserSong(db, userId, songId);

    if (existing) {
        await db.update(userSongTable)
            .set({ likeStatus, version: now })
            .where(and(eq(userSongTable.userId, userId), eq(userSongTable.songId, songId)));
    } else {
        await db.insert(userSongTable).values([{ userId, songId, likeStatus, lastPlayed: now, version: now }]);
    }
}
