import { GenericDb } from "../GenericDb";
import { Artist, Song } from "../models";
import { artistTable, playlistSongTable, songArtistTable, songTable, userSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

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

export async function updateSongs(db: GenericDb, songs: Song[]) {
    if (!songs.length) {
        return;
    }

    await db.delete(songTable).where(inArray(songTable.songId, songs.map(x => x.songId)));
    await db.insert(songTable).values(songs);
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
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId));
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

