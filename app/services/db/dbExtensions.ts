import axios, { AxiosInstance } from "axios";
import { eq, ExtractTablesWithRelations, inArray, sql, isNotNull, and } from "drizzle-orm";
import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { SQLiteRunResult } from "expo-sqlite";
import { artistTable, localSessionDataTable, playlistSongTable, playlistTable, recentlyPlayedSongTable, requestTable, songArtistTable, songTable, songTagTable, tagTable, userSongTable, userTable } from "./schema";
import { Artist, Playlist, PlaylistSong, Song, SongArtist, SongTag, Tag, User, UserSong, Request, RecentlyPlayedSong } from "./models";

type GenericDb = ExpoSQLiteDatabase | SQLiteTransaction<"sync", SQLiteRunResult, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;

export async function getLocalSessionData(db: GenericDb, userId: number) {
    const result = await db.select().from(localSessionDataTable).where(eq(localSessionDataTable.userId, userId)).limit(1);

    if (result.length) {
        return result[0];
    }

    return undefined;
}

export async function getActiveLocalSessionData(db: GenericDb) {
    const result = await db.select().from(localSessionDataTable).where(isNotNull(localSessionDataTable.expiration)).limit(1);

    if (result.length) {
        return result[0];
    }

    return undefined;
}

export async function setActiveLocalSessionPlaylistId(db: GenericDb, playlistId: number) {
    await db.update(localSessionDataTable).set({currentPlaylistId: playlistId});
}

export async function getCurrentlyPlayingSong(db: GenericDb) {
    const result = await db.select().from(recentlyPlayedSongTable).where(isNotNull(recentlyPlayedSongTable.timestampSeconds));

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

export async function getRecentlyPlayedSong(db: GenericDb, songId: number) {
    const result = await db.select().from(recentlyPlayedSongTable).where(eq(recentlyPlayedSongTable.songId, songId));

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

export async function resetRecentlyPlayedSongTimestamps(db: GenericDb) {
    await db.update(recentlyPlayedSongTable).set({
        timestampSeconds: null
    }).where(isNotNull(recentlyPlayedSongTable.timestampSeconds));
}

export async function setRecentlyPlayedSongTimestampSeconds(db: GenericDb, songId: number, timestampSeconds: number) {
    await db.update(recentlyPlayedSongTable).set({
        timestampSeconds: timestampSeconds
    }).where(eq(recentlyPlayedSongTable.songId, songId));
}

export async function updateRecentlyPlayedSongLastPlayed(db: GenericDb, songId: number) {
    await db.update(recentlyPlayedSongTable).set({
        lastPlayed: new Date(Date.now())
    }).where(eq(recentlyPlayedSongTable.songId, songId));
}

export async function addRecentlyPlayedSong(db: GenericDb, recentlyPlayedSong: RecentlyPlayedSong) {
    await db.insert(recentlyPlayedSongTable).values([recentlyPlayedSong]);
}

export async function updateTags(db: GenericDb, newTags: Tag[]) {
    const localTags = await db.select().from(tagTable);
    const tagsToRemove = localTags.filter(localTag => !newTags.some(newTag => newTag.tagId === localTag.tagId));

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

export async function updateSongs(db: GenericDb, songs: Song[]) {
    await db.delete(songTable).where(inArray(songTable.songId, songs.map(x => x.songId)));
    await db.insert(songTable).values(songs);
}

export async function updatePlaylistSongs(db: GenericDb, playlistId: number, newPlaylistSongs: PlaylistSong[]) {
    await db.delete(playlistSongTable).where(eq(playlistSongTable.playlistId, playlistId));
    await db.insert(playlistSongTable).values(newPlaylistSongs);
}

export async function updateSongTags(db: GenericDb, songTags: SongTag[]) {
    await db.insert(songTagTable).values(songTags).onConflictDoNothing();
}

export async function updateSongArtists(db: GenericDb, songArtists: SongArtist[]) {
    await db.insert(songArtistTable).values(songArtists).onConflictDoNothing();
}

export async function updateArtists(db: GenericDb, artists: Artist[]) {
    await db.insert(artistTable).values(artists).onConflictDoUpdate({
        target: artistTable.artistId,
        set: {
            name: sql`excluded.name`
        }
    });
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

export async function getRandomSongId(db: GenericDb) {
    const songCount = (await db.select({
        count: sql<number>`COUNT(*)`.as("count"),
    }).from(songTable))[0].count;
    const randomSongIndex = Math.floor(songCount * Math.random());
    
    const song = await db
        .select({
            songId: songTable.songId
        })
        .from(songTable)
        .offset(randomSongIndex)
        .limit(1);

    if (!song.length) {
        return undefined;
    }

    return song[0].songId;
}

export async function getRandomSongIdByPlaylist(db: GenericDb, playlistId: number) {
    const songCount = (await db.select({
        count: sql<number>`COUNT(*)`.as("count"),
    }).from(songTable)
    .innerJoin(playlistSongTable, eq(songTable.songId, playlistSongTable.songId))
    .where(eq(playlistSongTable.playlistId, playlistId)))[0].count;
    const randomSongIndex = Math.floor(songCount * Math.random());
    
    const song = await db
        .select({
            songId: songTable.songId
        })
        .from(songTable)
        .innerJoin(playlistSongTable, eq(songTable.songId, playlistSongTable.songId))
        .where(eq(playlistSongTable.playlistId, playlistId))
        .offset(randomSongIndex)
        .limit(1);

    if (song.length == 0) {
        return undefined;
    }

    return song[0].songId;
}

export async function getSongDetails(db: GenericDb, songId: number) {
    const song = await db
        .select({
            songId: songTable.songId,
            name: songTable.name,
            directory: songTable.directory,
            artist: {
                artistId: artistTable.artistId,
                name: artistTable.name
            }
        })
        .from(songTable)
        .where(eq(songTable.songId, songId))
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.songId, artistTable.artistId));
    // TODO: this doesn't work if there are multiple artists

    if (!song.length) {
        const errMsg = `Song ${songId} cannot be found in getSongDetails.`;
        console.log(errMsg);
        throw Error(errMsg);
    }

    return song[0];
}

export async function getSong(db: GenericDb, songId: number) {
    const song = await db.select().from(songTable).where(eq(songTable.songId, songId));

    if (!song.length) {
        return undefined;
    }

    return song[0];
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

export async function addRequest(db: GenericDb, request: Request) {
    await db.insert(requestTable).values([request]);
}

export async function getPlaylists(db: GenericDb, userId: number) {
    return await db.select().from(playlistTable).where(eq(playlistTable.userId, userId));
}
