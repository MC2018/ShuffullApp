import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite"
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { SQLiteRunResult } from "expo-sqlite";
import { artistTable, downloadQueueTable, localSessionDataTable, playlistSongTable, playlistTable, recentlyPlayedSongTable, requestTable, songArtistTable, songTable, songTagTable, tagTable, userSongTable, userTable } from "./schema";
import { Artist, Playlist, PlaylistSong, Song, SongArtist, SongTag, Tag, User, UserSong, Request, RecentlyPlayedSong } from "./models";
import { DownloadPriority } from "@/app/tools/DownloadManager";

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

export async function getRecentlyPlayedSong(db: GenericDb, recentlyPlayedSongGuid: string) {
    const result = await db.select().from(recentlyPlayedSongTable).where(eq(recentlyPlayedSongTable.recentlyPlayedSongGuid, recentlyPlayedSongGuid));

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

export async function updateRecentlyPlayedSongTimestamp(db: GenericDb, recentlyPlayedSongGuid: string) {
    await db.update(recentlyPlayedSongTable).set({
        timestampSeconds: 0
    }).where(eq(recentlyPlayedSongTable.recentlyPlayedSongGuid, recentlyPlayedSongGuid));
}

export async function addRecentlyPlayedSong(db: GenericDb, recentlyPlayedSong: RecentlyPlayedSong) {
    await db.insert(recentlyPlayedSongTable).values([recentlyPlayedSong]);
}

export async function getRecentlyPlayedSongs(db: GenericDb) {
    return await db.select()
        .from(recentlyPlayedSongTable)
        .orderBy(recentlyPlayedSongTable.lastPlayed);
}

export async function removeAllRecentlyPlayedSongs(db: GenericDb) {
    await db.delete(recentlyPlayedSongTable);
}

export async function checkForLastRecentlyPlayedSong(db: GenericDb) {
    return await checkForRecentlyPlayedSong(db, false);
}

export async function checkForNextRecentlyPlayedSong(db: GenericDb) {
    return await checkForRecentlyPlayedSong(db, true);
}

export async function checkForRecentlyPlayedSong(db: GenericDb, next: boolean) {
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

export type SongWithArtist = {
    song: Song;
    artists: Artist[];
}

export async function getAllSongsWithArtists(db: GenericDb) {
    const result: SongWithArtist[] = [];

    const rawData = await db.select({
        song: songTable,
        artist: artistTable
    }).from(songTable)
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .orderBy(asc(songTable.songId));
    
    let nextSongWithArtist: SongWithArtist | undefined = undefined;

    for (let i = 0; i < rawData.length; i++) {
        if (nextSongWithArtist == undefined || rawData[i].song.songId != nextSongWithArtist.song.songId) {
            nextSongWithArtist = {
                song: rawData[i].song,
                artists: []
            };
        }
        
        const artist = rawData[i].artist;

        if (artist != null) {
            nextSongWithArtist.artists.push(artist);
        }

        if (i + 1 >= rawData.length || rawData[i + 1].song.songId != nextSongWithArtist.song.songId) {
            result.push(nextSongWithArtist);
        }
    }

    return result;
}

export async function getSongsByPlaylist(db: GenericDb, playlistId: number) {
    return await db.select({
        songId: songTable.songId,
        directory: songTable.directory
    })
        .from(songTable)
        .innerJoin(playlistSongTable, eq(songTable.songId, playlistSongTable.songId))
        .where(eq(playlistSongTable.playlistId, playlistId));
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
    if (!songs.length) {
        return;
    }

    await db.delete(songTable).where(inArray(songTable.songId, songs.map(x => x.songId)));
    await db.insert(songTable).values(songs);
}

export async function updatePlaylistSongs(db: GenericDb, playlistId: number, newPlaylistSongs: PlaylistSong[]) {
    if (!newPlaylistSongs.length) {
        return;
    }
    
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
    // TODO: figure out if there's simpler way to do this in the following query
    const songCount = (await db.select({
        count: sql<number>`COUNT(*)`.as("count"),
    }).from(songTable)
        .innerJoin(playlistSongTable, eq(songTable.songId, playlistSongTable.songId))
        .where(eq(playlistSongTable.playlistId, playlistId)))[0].count;
    const randomSongIndex = Math.floor(songCount * Math.random() * 0.3);
    
    const song = await db
        .select({
            songId: songTable.songId
        })
        .from(songTable)
        .innerJoin(playlistSongTable, eq(songTable.songId, playlistSongTable.songId))
        .leftJoin(userSongTable, eq(songTable.songId, userSongTable.songId))
        .where(eq(playlistSongTable.playlistId, playlistId))
        .orderBy(asc(userSongTable.lastPlayed), sql`RANDOM()`) // Random is for when lastPlayed is the same
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

// TODO: I may want to add a way to change priority
export async function addToDownloadQueue(db: GenericDb, songIds: number[], priority: DownloadPriority) {
    if (!songIds.length) {
        return;
    }

    await db.insert(downloadQueueTable).values(songIds.map(x => ({
        songId: x,
        priority: priority
    }))).onConflictDoNothing();
}

export async function getFromDownloadQueue(db: GenericDb) {
    const result = await db.select().from(downloadQueueTable)
        .orderBy(desc(downloadQueueTable.priority), asc(downloadQueueTable.downloadQueueId))
        .limit(1);

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

export async function removeFromDownloadQueue(db: GenericDb, songId: number) {
    await db.delete(downloadQueueTable).where(eq(downloadQueueTable.songId, songId));
}
