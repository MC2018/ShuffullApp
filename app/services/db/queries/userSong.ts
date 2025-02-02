import { GenericDb } from "../GenericDb";
import { UserSong } from "../models";
import { userSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { getActiveLocalSessionData } from "./localSessionData";

export async function updateUserSongs(db: GenericDb, userSongs: UserSong[]) {
    const localSessionData = await getActiveLocalSessionData(db);

    if (!localSessionData) {
        throw new Error("Local session data is undefined while updating user songs.");
    }
    
    const songIds = userSongs.map(x => x.songId);
    const localUserSongs = await db
        .select()
        .from(userSongTable)
        .where(
            and(
                eq(userSongTable.userId, localSessionData.userId),
                inArray(userSongTable.songId, songIds)
            )
        );
    const localuserSongIds = localUserSongs.map(x => x.songId);
    
    if (localUserSongs.length) {
        await db.delete(userSongTable).where(inArray(userSongTable.songId, localuserSongIds));
    }
    
    if (userSongs.length) {
        await db.insert(userSongTable).values(userSongs);
    }
}

export async function updateUserSongLastPlayed(db: GenericDb, userId: number, songId: number, lastPlayed: Date) {
    await db.update(userSongTable).set({
        lastPlayed: lastPlayed
    }).where(and(eq(userSongTable.userId, userId), eq(userSongTable.songId, songId)));
}

export async function getUserSong(db: GenericDb, userId: number, songId: number) {
    const userSong = await db.select().from(userSongTable).where(and(eq(userSongTable.userId, userId), eq(userSongTable.songId, songId)));

    if (!userSong.length) {
        return undefined;
    }

    return userSong[0];
}

export async function addUserSong(db: GenericDb, userSong: UserSong) {
    await db.insert(userSongTable).values([userSong]);
}
