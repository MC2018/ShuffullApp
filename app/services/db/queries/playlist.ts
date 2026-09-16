import { GenericDb } from "../GenericDb";
import { Playlist, Song } from "../models";
import { downloadedSongTable, playlistSongTable, playlistTable, songArtistTable, songTable, songTagTable, userSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { generateId } from "@/app/tools/pure";
import { chunkIds } from "./_chunk";

export async function removeOldPlaylists(db: GenericDb, accessiblePlaylistIds: string[]): Promise<void> {
    // Drop only the local playlists the user no longer has access to (NOT in the server's accessible set).
    // Accessible playlists are kept as-is; the sync separately re-fetches just the changed/new ones. (This
    // condition was previously inverted — it deleted the accessible playlists, so any accessible playlist the
    // sync didn't re-fetch that pass, e.g. a just-created one whose version already matched, vanished.)
    const staleIds = (await db.select().from(playlistTable))
        .map(x => x.playlistId)
        .filter(x => !accessiblePlaylistIds.includes(x));
    for (const idChunk of chunkIds(staleIds)) {
        await db.delete(playlistTable).where(inArray(playlistTable.playlistId, idChunk));
    }
}

export async function updatePlaylist(db: GenericDb, newPlaylist: Playlist): Promise<void> {
    await db.delete(playlistTable).where(eq(playlistTable.playlistId, newPlaylist.playlistId));
    await db.insert(playlistTable).values([
        newPlaylist
    ]);
}

export async function getPlaylists(db: GenericDb, userId: string): Promise<Playlist[]> {
    return await db.select().from(playlistTable).where(eq(playlistTable.userId, userId));
}

export async function getPlaylist(db: GenericDb, playlistId: string): Promise<Playlist | undefined> {
    const result = await db.select().from(playlistTable).where(eq(playlistTable.playlistId, playlistId));

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

// The ids of the local playlists that already contain the given song — used to show membership in the
// "add to playlist" sheet.
export async function getPlaylistIdsContainingSong(db: GenericDb, songId: string): Promise<string[]> {
    const rows = await db
        .select({ playlistId: playlistSongTable.playlistId })
        .from(playlistSongTable)
        .where(eq(playlistSongTable.songId, songId));
    return rows.map((r) => r.playlistId);
}

// Optimistic local mirrors of the server add/remove (the next sync reconciles from the server, which now
// includes/excludes the song). Callers gate on membership, so no duplicate join rows are created.
export async function addSongToPlaylist(db: GenericDb, playlistId: string, songId: string): Promise<void> {
    await db.insert(playlistSongTable).values([{ playlistSongId: generateId(), playlistId, songId }]);
}

export async function removeSongFromPlaylist(db: GenericDb, playlistId: string, songId: string): Promise<void> {
    await db
        .delete(playlistSongTable)
        .where(and(eq(playlistSongTable.playlistId, playlistId), eq(playlistSongTable.songId, songId)));
}

// One row per song of a playlist with the fields the audition-state derivation needs (see tools/audition):
// the song's exploratory flag plus the user's likeStatus/lastPlayed (null when no UserSong row exists yet).
// All three inputs sync through the server, so the derived states are identical across devices.
export interface PlaylistSongState {
    songId: string;
    exploratory: boolean;
    likeStatus: number | null;
    lastPlayed: Date | null;
}

export async function getPlaylistSongStates(db: GenericDb, userId: string, playlistId: string): Promise<PlaylistSongState[]> {
    return await db
        .select({
            songId: songTable.songId,
            exploratory: songTable.exploratory,
            likeStatus: userSongTable.likeStatus,
            lastPlayed: userSongTable.lastPlayed,
        })
        .from(playlistSongTable)
        .innerJoin(songTable, eq(songTable.songId, playlistSongTable.songId))
        .leftJoin(userSongTable, and(eq(userSongTable.songId, playlistSongTable.songId), eq(userSongTable.userId, userId)))
        .where(eq(playlistSongTable.playlistId, playlistId));
}

// Deletes a playlist locally and, for an audition (exploratory) playlist, purges the songs the user never kept
// - mirroring the server's own delete-purge so the local library matches without waiting for a full re-sync. A
// song is purged only when it is still exploratory (never promoted by a keep) AND no other playlist references
// it; its joins/sentiment/download rows and the song row go too. Returns the purged Song rows so the caller can
// delete their downloaded media files. The server delete is enqueued separately (through the outbox).
export async function deletePlaylistAndPurge(db: GenericDb, playlistId: string): Promise<Song[]> {
    const playlist = await getPlaylist(db, playlistId);
    if (!playlist) {
        return [];
    }

    const songIds = (await db
        .select({ songId: playlistSongTable.songId })
        .from(playlistSongTable)
        .where(eq(playlistSongTable.playlistId, playlistId)))
        .map(r => r.songId);

    // Remove this playlist's joins + the row first, so the "still referenced?" check below is clean.
    await db.delete(playlistSongTable).where(eq(playlistSongTable.playlistId, playlistId));
    await db.delete(playlistTable).where(eq(playlistTable.playlistId, playlistId));

    if (!playlist.isExploratory || !songIds.length) {
        return [];
    }

    const purged: Song[] = [];
    for (const songId of songIds) {
        const song = (await db.select().from(songTable).where(eq(songTable.songId, songId)))[0];
        if (!song?.exploratory) {
            continue;
        }

        const stillReferenced = (await db
            .select({ playlistId: playlistSongTable.playlistId })
            .from(playlistSongTable)
            .where(eq(playlistSongTable.songId, songId))).length > 0;
        if (stillReferenced) {
            continue;
        }

        await db.delete(songArtistTable).where(eq(songArtistTable.songId, songId));
        await db.delete(songTagTable).where(eq(songTagTable.songId, songId));
        await db.delete(userSongTable).where(eq(userSongTable.songId, songId));
        await db.delete(downloadedSongTable).where(eq(downloadedSongTable.songId, songId));
        await db.delete(songTable).where(eq(songTable.songId, songId));
        purged.push(song);
    }

    return purged;
}
