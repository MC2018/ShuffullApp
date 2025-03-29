import { SongFilters } from "@/app/types/SongFilters";
import { GenericDb } from "../GenericDb";
import { Artist, GenreJam, Song } from "../models";
import { artistTable, downloadedSongTable, genreJamTable, playlistSongTable, playlistTable, songArtistTable, songTable, userSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export type SongDetails = {
    song: Song;
    artists: Artist[];
}

type FilteredSongs = {
    songId: number,
    lastPlayed?: number,
};

export async function getFilteredSong(db: GenericDb, songFilters: SongFilters) {
    const whitelistArtists = JSON.stringify(songFilters.whitelists.artistIds);
    const whitelistPlaylists = JSON.stringify(songFilters.whitelists.playlistIds);
    const whitelistGenres = JSON.stringify(songFilters.whitelists.genreIds);
    const whitelistLanguages = JSON.stringify(songFilters.whitelists.languageIds);
    const whitelistTimePeriods = JSON.stringify(songFilters.whitelists.timePeriodIds);
    const blacklistArtists = JSON.stringify(songFilters.blacklists.artistIds);
    const blacklistPlaylists = JSON.stringify(songFilters.blacklists.playlistIds);
    const blacklistGenres = JSON.stringify(songFilters.blacklists.genreIds);
    const blacklistLanguages = JSON.stringify(songFilters.blacklists.languageIds);
    const blacklistTimePeriods = JSON.stringify(songFilters.blacklists.timePeriodIds);
    const whitelistsEmpty = !songFilters.hasAnyWhitelistFilter();
    const blacklistsEmpty = !songFilters.hasAnyBlacklistFilter();

    const filteredSongs = db.all<FilteredSongs>(sql`
        WITH FilteredSongs AS (
            SELECT s.song_id, us.last_played
            FROM songs s
            LEFT JOIN user_songs us ON s.song_id = us.song_id
            WHERE
                ${songFilters.localOnly ? "EXISTS (SELECT 1 FROM downloaded_songs ds WHERE ds.song_id = s.song_id)" : "1 = 1"}
            AND (
                ${whitelistsEmpty ? 1 : 0} = 1 OR
                (
                    (
                        -- Group for artist/playlist: if both are empty, pass; otherwise require a match on at least one.
                        (${whitelistArtists} = '[]' AND ${whitelistPlaylists} = '[]')
                        OR EXISTS (
                            SELECT 1
                            FROM song_artists sa
                            WHERE sa.song_id = s.song_id
                            AND sa.artist_id IN (
                                SELECT value FROM json_each(${whitelistArtists})
                            )
                        )
                        OR EXISTS (
                            SELECT 1
                            FROM playlist_songs ps
                            WHERE ps.song_id = s.song_id
                            AND ps.playlist_id IN (
                                SELECT value FROM json_each(${whitelistPlaylists})
                            )
                        )
                    )
                    AND 
                    -- For each tag filter, if non-empty, require at least one match.
                    (${whitelistGenres} = '[]' OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${whitelistGenres})
                        )
                    ))
                    AND (${whitelistTimePeriods} = '[]' OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${whitelistTimePeriods})
                        )
                    ))
                    AND (${whitelistLanguages} = '[]' OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${whitelistLanguages})
                        )
                    ))
                )
            )
            AND (
                ${blacklistsEmpty ? 1 : 0} = 1 OR NOT (
                    EXISTS (
                        SELECT 1
                        FROM song_artists sa
                        WHERE sa.song_id = s.song_id
                        AND sa.artist_id IN (
                            SELECT value FROM json_each(${blacklistArtists})
                        )
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM playlist_songs ps
                        WHERE ps.song_id = s.song_id
                        AND ps.playlist_id IN (
                            SELECT value FROM json_each(${blacklistPlaylists})
                        )
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${blacklistGenres})
                        )
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${blacklistLanguages})
                        )
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${blacklistTimePeriods})
                        )
                    )
                )
            )
            ORDER BY us.last_played ASC
        )
        SELECT song_id as songId, last_played AS lastPlayed
        FROM FilteredSongs
        LIMIT 500
    `);

    return filteredSongs;
}

export async function getAllSongDetails(db: GenericDb): Promise<SongDetails[]> {
    const result: SongDetails[] = [];
    const rawData = await db
        .select({
            song: songTable,
            artist: artistTable
        })
        .from(songTable)
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .orderBy(asc(songTable.songId));
    
    let nextSongDetails: SongDetails | undefined = undefined;

    for (let i = 0; i < rawData.length; i++) {
        if (nextSongDetails == undefined || rawData[i].song.songId != nextSongDetails.song.songId) {
            nextSongDetails = {
                song: rawData[i].song,
                artists: []
            };
        }
        
        const artist = rawData[i].artist;

        if (artist != null) {
            nextSongDetails.artists.push(artist);
        }

        if (i + 1 >= rawData.length || rawData[i + 1].song.songId != nextSongDetails.song.songId) {
            result.push(nextSongDetails);
        }
    }

    return result;
}

// TODO: this is duplicated code from above, try to remove in the future
export async function getSongDetailsByPlaylist(db: GenericDb, playlistId: number): Promise<SongDetails[]> {
    const result: SongDetails[] = [];
    const rawData = await db
        .selectDistinct({
            song: songTable,
            artist: artistTable
        })
        .from(playlistSongTable)
        .where(eq(playlistSongTable.playlistId, playlistId))
        .innerJoin(songTable, eq(songTable.songId, playlistSongTable.songId))
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .orderBy(asc(songTable.songId));

    let nextSongDetails: SongDetails | undefined = undefined;

    for (let i = 0; i < rawData.length; i++) {
        if (nextSongDetails == undefined || rawData[i].song.songId != nextSongDetails.song.songId) {
            nextSongDetails = {
                song: rawData[i].song,
                artists: []
            };
        }
        
        const artist = rawData[i].artist;

        if (artist != null) {
            nextSongDetails.artists.push(artist);
        }

        if (i + 1 >= rawData.length || rawData[i + 1].song.songId != nextSongDetails.song.songId) {
            result.push(nextSongDetails);
        }
    }

    return result;
}

// TODO: this is duplicated code from above, try to remove in the future
export async function getDownloadedSongDetails(db: GenericDb): Promise<SongDetails[]> {
    const result: SongDetails[] = [];
    const rawData = await db
        .selectDistinct({
            song: songTable,
            artist: artistTable
        })
        .from(downloadedSongTable)
        .innerJoin(songTable, eq(songTable.songId, downloadedSongTable.songId))
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .orderBy(asc(songTable.songId));
    
    let nextSongDetails: SongDetails | undefined = undefined;

    for (let i = 0; i < rawData.length; i++) {
        if (nextSongDetails == undefined || rawData[i].song.songId != nextSongDetails.song.songId) {
            nextSongDetails = {
                song: rawData[i].song,
                artists: []
            };
        }
        
        const artist = rawData[i].artist;

        if (artist != null) {
            nextSongDetails.artists.push(artist);
        }

        if (i + 1 >= rawData.length || rawData[i + 1].song.songId != nextSongDetails.song.songId) {
            result.push(nextSongDetails);
        }
    }

    return result;
}

export async function getSongsByPlaylist(db: GenericDb, playlistId: number): Promise<Song[]> {
    return await db
        .select({
            songId: songTable.songId,
            fileExtension: songTable.fileExtension,
            fileHash: songTable.fileHash,
            name: songTable.name,
            artist: {
                artistId: artistTable.artistId,
                name: artistTable.name
            }
        })
        .from(songTable)
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId));
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
export async function fetchSongDetails(db: GenericDb, songId: number): Promise<SongDetails> {
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

    let result: SongDetails = {
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
