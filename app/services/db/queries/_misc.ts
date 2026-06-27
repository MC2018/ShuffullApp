import { GenericDb } from "../GenericDb";
import { Artist, PlaylistSong, SongArtist, SongTag } from "../models";
import { artistTable, playlistSongTable, songArtistTable, songTagTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function updatePlaylistSongs(db: GenericDb, playlistId: string, newPlaylistSongs: PlaylistSong[]): Promise<void> {
    if (!newPlaylistSongs.length) {
        return;
    }
    
    await db.delete(playlistSongTable).where(eq(playlistSongTable.playlistId, playlistId));
    await db.insert(playlistSongTable).values(newPlaylistSongs);
}

export async function updateSongTags(db: GenericDb, songTags: SongTag[]): Promise<void> {
    await db.insert(songTagTable).values(songTags).onConflictDoNothing();
}

export async function updateSongArtists(db: GenericDb, songArtists: SongArtist[]): Promise<void> {
    await db.insert(songArtistTable).values(songArtists).onConflictDoNothing();
}

// Clears a song's existing artist/tag joins so they can be rebuilt from fresh data. Needed when re-syncing a
// song that already exists (updateSongArtists/updateSongTags only insert), so a changed artist/tag set on a
// replaced song doesn't leave stale joins behind.
export async function deleteSongArtistsAndTags(db: GenericDb, songIds: string[]): Promise<void> {
    if (!songIds.length) {
        return;
    }
    await db.delete(songArtistTable).where(inArray(songArtistTable.songId, songIds));
    await db.delete(songTagTable).where(inArray(songTagTable.songId, songIds));
}
