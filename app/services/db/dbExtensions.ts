import axios, { AxiosInstance } from "axios";
import { eq, ExtractTablesWithRelations, inArray, sql, isNotNull, and } from "drizzle-orm";
import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { SQLiteRunResult } from "expo-sqlite";
import { localSessionDataTable, playlistSongTable, playlistTable, tagTable, userSongTable, userTable } from "./schema";
import { Playlist, PlaylistSong, Tag, User, UserSong } from "./models";

type GenericDb = ExpoSQLiteDatabase | SQLiteTransaction<"sync", SQLiteRunResult, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;

export async function getLocalSessionData(db: GenericDb, userId: number) {
    const result = await db.select().from(localSessionDataTable).where(eq(localSessionDataTable.userId, userId)).limit(1);

    if (result.length) {
        return result[0];
    }

    return null;
}

export async function getActiveLocalSessionData(db: GenericDb) {
    const result = await db.select().from(localSessionDataTable).where(isNotNull(localSessionDataTable.expiration)).limit(1);

    if (result.length) {
        return result[0];
    }

    return null;
}

export async function updateTags(db: GenericDb, newTags: Tag[]) {
    const localTags = await db.select().from(tagTable);
    let tagsToRemove = localTags.filter(localTag => !newTags.some(newTag => newTag.tagId === localTag.tagId));

    await db.insert(tagTable).values(newTags).onConflictDoUpdate({
        target: tagTable.tagId,
        set: {
            name: sql`excluded.name`
        }
    });
    
    if (tagsToRemove) {
        for (const tagToRemove of tagsToRemove) {
            await db.delete(tagTable).where(eq(tagTable.tagId, tagToRemove.tagId));
        }
    }
}

export async function updateUser(db: GenericDb, newUser: User) {
    await db.delete(userTable).where(eq(userTable.userId, newUser.userId));
    await db.insert(userTable).values([
        newUser
    ]);
}

export async function removeOldPlaylists(db: GenericDb, accessiblePlaylistIds: number[]) {
    const localPlaylistIds = (await db.select().from(playlistTable)).map(x => x.playlistId);
    await db.delete(playlistTable).where(inArray(playlistTable.playlistId, localPlaylistIds));
}

export async function updatePlaylist(db: GenericDb, newPlaylist: Playlist) {
    await db.delete(playlistTable).where(eq(playlistTable.playlistId, newPlaylist.playlistId));
    await db.insert(playlistTable).values([
        newPlaylist
    ]);
}

export async function updatePlaylistSongs(db: GenericDb, playlistId: number, newPlaylistSongs: PlaylistSong[]) {
    await db.delete(playlistSongTable).where(eq(playlistSongTable.playlistId, playlistId));
    await db.insert(playlistSongTable).values(newPlaylistSongs);
}

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
        await db.insert(userSongTable).values(userSongs);
    } else {
        await db.insert(userSongTable).values(userSongs);
    }
}