import { GenericDb } from "../GenericDb";
import { Playlist } from "../models";
import { playlistSongTable, playlistTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { generateId } from "@/app/tools";

export async function removeOldPlaylists(db: GenericDb, accessiblePlaylistIds: string[]): Promise<void> {
    // Drop only the local playlists the user no longer has access to (NOT in the server's accessible set).
    // Accessible playlists are kept as-is; the sync separately re-fetches just the changed/new ones. (This
    // condition was previously inverted — it deleted the accessible playlists, so any accessible playlist the
    // sync didn't re-fetch that pass, e.g. a just-created one whose version already matched, vanished.)
    const staleIds = (await db.select().from(playlistTable))
        .map(x => x.playlistId)
        .filter(x => !accessiblePlaylistIds.includes(x));
    if (staleIds.length) {
        await db.delete(playlistTable).where(inArray(playlistTable.playlistId, staleIds));
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
