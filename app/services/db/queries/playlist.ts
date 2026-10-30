import { GenericDb } from "../GenericDb";
import { Playlist, Song } from "../models";
import { playlistSongTable, playlistTable, songTable, userSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { generateId } from "@/app/tools/pure";
import {
    AuditionProgress, AuditionScope, auditionProgress, auditionScopePlaylistId, deriveAuditionRowState, isAuditionComplete,
    shouldStopForFinishedAudition,
} from "@/app/tools/audition";
import { LikeStatus } from "@/app/enums";
import { chunkIds } from "./_chunk";
import { purgeSongs } from "./song";

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

// The ids of the songs in a local playlist, recorded on its delete row so the delete hold knows which Keeps
// it waits on.
export async function getPlaylistSongIds(db: GenericDb, playlistId: string): Promise<string[]> {
    return (await db
        .select({ songId: playlistSongTable.songId })
        .from(playlistSongTable)
        .where(eq(playlistSongTable.playlistId, playlistId)))
        .map(r => r.songId);
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

/**
 * The songs audition mode deals out for a mix: the ones the playlist screen shows as unheard, in the order it lists
 * them. Derived from synced data alone, so leaving and coming back resumes with exactly what is still unheard.
 */
export async function getAuditionDeckSongIds(db: GenericDb, userId: string, playlistId: string): Promise<string[]> {
    const rows = await getPlaylistSongStates(db, userId, playlistId);
    return rows
        .filter(r => deriveAuditionRowState(r.exploratory, (r.likeStatus ?? LikeStatus.Neutral) as LikeStatus, r.lastPlayed) === "unheard")
        .map(r => r.songId)
        .sort(); // by song id, the order the playlist screen lists them in
}

/**
 * The evaluated/total count of an audition playlist, from the same derivation the screen and the library bubble
 * render, so the player's stop-when-done rule agrees with the number on screen. Undefined for a playlist that is
 * not an audition (or not on this device): ordinary playlists have no evaluation to finish.
 */
export async function getAuditionProgress(db: GenericDb, userId: string, playlistId: string): Promise<AuditionProgress | undefined> {
    const playlist = await getPlaylist(db, playlistId);
    if (!playlist?.isExploratory) {
        return undefined;
    }
    const rows = await getPlaylistSongStates(db, userId, playlistId);
    return auditionProgress(rows.map(r =>
        deriveAuditionRowState(r.exploratory, (r.likeStatus ?? LikeStatus.Neutral) as LikeStatus, r.lastPlayed)));
}

/**
 * The audition the player's scope is working through, if it still has songs to evaluate. The player reads this as a
 * song starts, BEFORE the start stamps lastPlayed: the song that completes a mix has to find it unfinished, so that
 * the mix can finish when that song ends.
 */
export async function getIncompleteAuditionPlaylistId(db: GenericDb, userId: string, scope: AuditionScope): Promise<string | undefined> {
    const scopePlaylistId = auditionScopePlaylistId(scope);
    if (scopePlaylistId == undefined) {
        return undefined;
    }
    const progress = await getAuditionProgress(db, userId, scopePlaylistId);
    return progress != undefined && !isAuditionComplete(progress) ? scopePlaylistId : undefined;
}

/**
 * The audition the player should stop for as it moves on from the current song, or undefined to play on.
 * `inProgressPlaylistId` is what getIncompleteAuditionPlaylistId returned when that song started.
 */
export async function getFinishedAuditionToStopFor(
    db: GenericDb, userId: string, scope: AuditionScope, inProgressPlaylistId: string | undefined,
): Promise<string | undefined> {
    const scopePlaylistId = auditionScopePlaylistId(scope);
    if (inProgressPlaylistId == undefined || scopePlaylistId == undefined) {
        return undefined;
    }
    const progress = await getAuditionProgress(db, userId, scopePlaylistId);
    return shouldStopForFinishedAudition(inProgressPlaylistId, scopePlaylistId, progress) ? scopePlaylistId : undefined;
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

        purged.push(...await purgeSongs(db, [songId]));
    }

    return purged;
}
