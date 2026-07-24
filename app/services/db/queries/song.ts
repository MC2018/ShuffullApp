import { SongFilters } from "@/app/types/SongFilters";
import { GenericDb } from "../GenericDb";
import { Artist, GenreJam, Song, UpdateSongMetadataPayload } from "../models";
import { artistTable, downloadedSongTable, genreJamTable, playlistSongTable, playlistTable, songArtistTable, songTable, songTagTable, tagTable, userSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { SongDetails } from "../types";
// Import the dependency-free helper directly (not via @/app/tools, which re-exports React-Native-bound utils)
// so this query module stays importable from the Vitest (node) test harness.
import { deterministicId } from "@/app/tools/pure";

type FilteredSongs = {
    songId: string,
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
    const whitelistMoods = JSON.stringify(songFilters.whitelists.moodIds ?? []);
    const blacklistMoods = JSON.stringify(songFilters.blacklists.moodIds ?? []);
    const whitelistThemes = JSON.stringify(songFilters.whitelists.themeIds ?? []);
    const blacklistThemes = JSON.stringify(songFilters.blacklists.themeIds ?? []);
    const whitelistsEmpty = !songFilters.hasAnyWhitelistFilter();
    const blacklistsEmpty = !songFilters.hasAnyBlacklistFilter();

    const filteredSongs = db.all<FilteredSongs>(sql`
        WITH FilteredSongs AS (
            SELECT s.song_id, us.last_played
            FROM songs s
            LEFT JOIN user_songs us ON s.song_id = us.song_id
            WHERE
                -- Dislike = never play again: exclude disliked songs from shuffle (explicit play still allowed).
                (us.like_status IS NULL OR us.like_status <> 3)
            AND
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
                    AND (${whitelistMoods} = '[]' OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${whitelistMoods})
                        )
                    ))
                    AND (${whitelistThemes} = '[]' OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${whitelistThemes})
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
                    OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${blacklistMoods})
                        )
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM song_tags st
                        WHERE st.song_id = s.song_id
                        AND st.tag_id IN (
                            SELECT value FROM json_each(${blacklistThemes})
                        )
                    )
                )
            )
            AND (
                s.energy IS NULL
                OR (
                    (${songFilters.energyMin == null ? 1 : 0} = 1 OR s.energy >= ${songFilters.energyMin ?? 0})
                    AND (${songFilters.energyMax == null ? 1 : 0} = 1 OR s.energy <= ${songFilters.energyMax ?? 10})
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
export async function getSongDetailsByPlaylist(db: GenericDb, playlistId: string): Promise<SongDetails[]> {
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

export async function getSongDetailsByArtist(db: GenericDb, artistId: string): Promise<SongDetails[]> {
    // The songs credited to this artist...
    const songIdRows = await db
        .selectDistinct({ songId: songArtistTable.songId })
        .from(songArtistTable)
        .where(eq(songArtistTable.artistId, artistId));
    const songIds = songIdRows.map((r) => r.songId);

    if (songIds.length === 0) {
        return [];
    }

    // ...re-joined to ALL their artists, so each SongDetails carries its full credit (a song can have several).
    const rawData = await db
        .selectDistinct({
            song: songTable,
            artist: artistTable
        })
        .from(songTable)
        .where(inArray(songTable.songId, songIds))
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .orderBy(asc(songTable.songId));

    const result: SongDetails[] = [];
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

    // Assembly needs songId ordering; present alphabetically.
    result.sort((a, b) => a.song.name.localeCompare(b.song.name));
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

export async function getSongsByPlaylist(db: GenericDb, playlistId: string): Promise<Song[]> {
    return await db
        .select({
            songId: songTable.songId,
            fileExtension: songTable.fileExtension,
            fileHash: songTable.fileHash,
            name: songTable.name,
            syncedLyrics: songTable.syncedLyrics,
            plainLyrics: songTable.plainLyrics,
            lyricsInstrumental: songTable.lyricsInstrumental,
            lyricsSource: songTable.lyricsSource,
            bpm: songTable.bpm,
            energy: songTable.energy,
            exploratory: songTable.exploratory,
            tagsStale: songTable.tagsStale,
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

export async function getRandomSongId(db: GenericDb): Promise<string | undefined> {
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

export async function getRandomSongIdByPlaylist(db: GenericDb, playlistId: string): Promise<string | undefined> {
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

export async function getRandomDownloadedSongId(db: GenericDb): Promise<string | undefined> {
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
export async function fetchSongDetails(db: GenericDb, songId: string): Promise<SongDetails> {
    const song = await db
        .select({
            songId: songTable.songId,
            name: songTable.name,
            fileHash: songTable.fileHash,
            fileExtension: songTable.fileExtension,
            syncedLyrics: songTable.syncedLyrics,
            plainLyrics: songTable.plainLyrics,
            lyricsInstrumental: songTable.lyricsInstrumental,
            lyricsSource: songTable.lyricsSource,
            bpm: songTable.bpm,
            energy: songTable.energy,
            exploratory: songTable.exploratory,
            tagsStale: songTable.tagsStale,
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

export async function getSong(db: GenericDb, songId: string): Promise<Song | undefined> {
    const song = await db.select().from(songTable).where(eq(songTable.songId, songId));

    if (!song.length) {
        return undefined;
    }

    return song[0];
}

export async function getAllSongIds(db: GenericDb): Promise<string[]> {
    return (await db.select({ songId: songTable.songId }).from(songTable)).map(x => x.songId);
}

// Optimistic local promote: clear the audition + stale-tags flags right away so the song drops out of the
// audition view and can't re-promote while the queued re-tag reaches the server (the next sync re-pulls the
// enriched song either way).
export async function markSongPromoted(db: GenericDb, songId: string): Promise<void> {
    await db.update(songTable).set({ exploratory: false, tagsStale: false }).where(eq(songTable.songId, songId));
}

// Optimistic local mark for a KEEP (weak-model re-tag queued): the song leaves the audition state now, but
// its tags will be WEAK — tagsStale is set so a later like still promotes it to strong (the outbox's
// stronger-wins rule upgrades the pending row if the like lands before the sync flushes).
export async function markSongKept(db: GenericDb, songId: string): Promise<void> {
    await db.update(songTable).set({ exploratory: false, tagsStale: true }).where(eq(songTable.songId, songId));
}

// Optimistic local apply of a curator's metadata edit, so the UI reflects it immediately (the same edit is
// also queued to the server via the outbox; the next sync reconciles from the authoritative record).
// Artist ids are deterministic-by-name (matching the sync), so reusing/creating them here never diverges
// from what the server-driven sync rebuilds. Tags are only re-linked when we already hold a matching
// (name, type) tag locally — a brand-new tag is created server-side and pulled in by the next sync, so we
// avoid fabricating a local id that wouldn't match the server's.
export async function applySongMetadataEdit(db: GenericDb, songId: string, payload: UpdateSongMetadataPayload): Promise<void> {
    await db.update(songTable)
        .set({ name: payload.name, bpm: payload.bpm, energy: payload.energy })
        .where(eq(songTable.songId, songId));

    await db.delete(songArtistTable).where(eq(songArtistTable.songId, songId));
    const seenArtist = new Set<string>();
    for (const rawName of payload.artists) {
        const name = rawName.trim();
        if (name.length === 0 || seenArtist.has(name)) {
            continue;
        }
        seenArtist.add(name);
        const artistId = deterministicId("artist", name);
        await db.insert(artistTable).values({ artistId, name }).onConflictDoUpdate({
            target: artistTable.artistId,
            set: { name: sql`excluded.name` }
        });
        await db.insert(songArtistTable).values({
            songArtistId: deterministicId("song-artist", songId, artistId),
            songId,
            artistId
        }).onConflictDoNothing();
    }

    await db.delete(songTagTable).where(eq(songTagTable.songId, songId));
    const localTags = await db.select().from(tagTable);
    const seenTag = new Set<string>();
    for (const tag of payload.tags) {
        const name = tag.name.trim();
        const key = `${tag.type}:${name}`;
        if (name.length === 0 || seenTag.has(key)) {
            continue;
        }
        seenTag.add(key);
        const match = localTags.find(localTag => localTag.name === name && localTag.type === tag.type);
        if (match == null) {
            continue;
        }
        await db.insert(songTagTable).values({
            songTagId: deterministicId("song-tag", songId, match.tagId),
            songId,
            tagId: match.tagId
        }).onConflictDoNothing();
    }
}
