import { GenericDb } from "../GenericDb";
import { Artist, PlaylistSong, SongArtist, SongTag } from "../models";
import { artistTable, playlistSongTable, songArtistTable, songTagTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { chunkIds, chunkRows } from "./_chunk";

export async function updatePlaylistSongs(db: GenericDb, playlistId: string, newPlaylistSongs: PlaylistSong[]): Promise<void> {
    if (!newPlaylistSongs.length) {
        return;
    }

    await db.delete(playlistSongTable).where(eq(playlistSongTable.playlistId, playlistId));

    // A playlist can hold thousands of songs, so this insert is chunked like the rest (see _chunk.ts).
    for (const rowChunk of chunkRows(newPlaylistSongs)) {
        await db.insert(playlistSongTable).values(rowChunk);
    }
}

export async function updateSongTags(db: GenericDb, songTags: SongTag[]): Promise<void> {
    for (const rowChunk of chunkRows(songTags)) {
        await db.insert(songTagTable).values(rowChunk).onConflictDoNothing();
    }
}

export async function updateSongArtists(db: GenericDb, songArtists: SongArtist[]): Promise<void> {
    for (const rowChunk of chunkRows(songArtists)) {
        await db.insert(songArtistTable).values(rowChunk).onConflictDoNothing();
    }
}

// Clears a song's existing artist/tag joins so they can be rebuilt from fresh data. Needed when re-syncing a
// song that already exists (updateSongArtists/updateSongTags only insert), so a changed artist/tag set on a
// replaced song doesn't leave stale joins behind.
export async function deleteSongArtistsAndTags(db: GenericDb, songIds: string[]): Promise<void> {
    if (!songIds.length) {
        return;
    }
    for (const idChunk of chunkIds(songIds)) {
        await db.delete(songArtistTable).where(inArray(songArtistTable.songId, idChunk));
        await db.delete(songTagTable).where(inArray(songTagTable.songId, idChunk));
    }
}
