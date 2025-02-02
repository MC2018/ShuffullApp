import { GenericDb } from "../GenericDb";
import { Playlist } from "../models";
import { playlistTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function removeOldPlaylists(db: GenericDb, accessiblePlaylistIds: number[]): Promise<void> {
    const localPlaylistIds = (await db.select().from(playlistTable)).map(x => x.playlistId).filter(x => accessiblePlaylistIds.includes(x));
    await db.delete(playlistTable).where(inArray(playlistTable.playlistId, localPlaylistIds));
}

export async function updatePlaylist(db: GenericDb, newPlaylist: Playlist): Promise<void> {
    await db.delete(playlistTable).where(eq(playlistTable.playlistId, newPlaylist.playlistId));
    await db.insert(playlistTable).values([
        newPlaylist
    ]);
}

export async function getPlaylists(db: GenericDb, userId: number): Promise<Playlist[]> {
    return await db.select().from(playlistTable).where(eq(playlistTable.userId, userId));
}
