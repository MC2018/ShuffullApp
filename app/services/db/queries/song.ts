import { GenericDb } from "../GenericDb";
import { Artist, Song } from "../models";
import { artistTable, downloadedSongTable, playlistSongTable, songArtistTable, songTable, userSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export type SongWithArtists = {
    song: Song;
    artists: Artist[];
}

export async function getAllSongsWithArtists(db: GenericDb): Promise<SongWithArtists[]> {
    const result: SongWithArtists[] = [];

    const rawData = await db.select({
        song: songTable,
        artist: artistTable
    }).from(songTable)
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .orderBy(asc(songTable.songId));
    
    let nextSongWithArtist: SongWithArtists | undefined = undefined;

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

export async function getSongsByPlaylist(db: GenericDb, playlistId: number): Promise<Song[]> {
    return await db.select({
        songId: songTable.songId,
        fileExtension: songTable.fileExtension,
        fileHash: songTable.fileHash,
        name: songTable.name,
    })
        .from(songTable)
        .innerJoin(playlistSongTable, eq(songTable.songId, playlistSongTable.songId))
        .where(eq(playlistSongTable.playlistId, playlistId));
}

export async function updateSongs(db: GenericDb, songs: Song[]): Promise<void> {
    if (!songs.length) {
        return;
    }

    await db.delete(songTable).where(inArray(songTable.songId, songs.map(x => x.songId)));
    await db.insert(songTable).values(songs);
}

export async function getRandomSongId(db: GenericDb): Promise<number | undefined> {
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

export async function getRandomSongIdByPlaylist(db: GenericDb, playlistId: number): Promise<number | undefined> {
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

export async function getRandomDownloadedSongId(db: GenericDb): Promise<number | undefined> {
    // TODO: figure out if there's simpler way to do this in the following query
    const songCount = (await db.select({
        count: sql<number>`COUNT(*)`.as("count"),
    }).from(songTable)
        .innerJoin(downloadedSongTable, eq(songTable.songId, downloadedSongTable.songId))
        )[0].count;
    const randomSongIndex = Math.floor(songCount * Math.random() * 0.3);
    
    const song = await db
        .select({
            songId: songTable.songId
        })
        .from(songTable)
        .innerJoin(downloadedSongTable, eq(songTable.songId, downloadedSongTable.songId))
        .leftJoin(userSongTable, eq(songTable.songId, userSongTable.songId))
        .orderBy(asc(userSongTable.lastPlayed), sql`RANDOM()`) // Random is for when lastPlayed is the same
        .offset(randomSongIndex)
        .limit(1);

    if (song.length == 0) {
        return undefined;
    }

    return song[0].songId;
}

// TODO: add more than just artists to this
// TODO: this doesn't work if there are multiple artists
export async function fetchSongDetails(db: GenericDb, songId: number): Promise<SongWithArtists> {
    const song = await db
        .select({
            songId: songTable.songId,
            name: songTable.name,
            fileHash: songTable.fileHash,
            fileExtension: songTable.fileExtension,
            artist: {
                artistId: artistTable.artistId,
                name: artistTable.name
            }
        })
        .from(songTable)
        .where(eq(songTable.songId, songId))
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId));

    if (!song.length) {
        const errMsg = `Song ${songId} cannot be found in getSongDetails.`;
        console.log(errMsg);
        throw Error(errMsg);
    }

    let result: SongWithArtists = {
        song: song[0],
        artists: []
    };

    if (song[0].artist != null) {
        result.artists.push(song[0].artist);
    }

    for (let i = 1; i < song.length; i++) {
        const artist = song[i].artist;

        if (artist != null) {
            result.artists.push(artist);
        }
    }

    return result;
}

export async function getSong(db: GenericDb, songId: number): Promise<Song | undefined> {
    const song = await db.select().from(songTable).where(eq(songTable.songId, songId));

    if (!song.length) {
        return undefined;
    }

    return song[0];
}

export async function getAllSongIds(db: GenericDb): Promise<number[]> {
    return (await db.select({ songId: songTable.songId }).from(songTable)).map(x => x.songId);
}