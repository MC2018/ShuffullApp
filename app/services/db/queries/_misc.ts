import { GenericDb } from "../GenericDb";
import { Artist, PlaylistSong, SongArtist, SongTag } from "../models";
import { artistTable, playlistSongTable, songArtistTable, songTagTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function updatePlaylistSongs(db: GenericDb, playlistId: number, newPlaylistSongs: PlaylistSong[]): Promise<void> {
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
