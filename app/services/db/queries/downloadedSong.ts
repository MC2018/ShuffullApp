import { generateId } from "@/app/tools/pure";
import { GenericDb } from "../GenericDb";
import { downloadedSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { DownloadQueue } from "../models";
import { chunkIds } from "./_chunk";

// Idempotent: downloaded_songs has no unique constraint on song_id, and the Downloader also records songs it
// finds already on disk (a run that moved the file but died before getting here), so a second call must not
// add a duplicate row - every join on this table would then return the song twice.
export async function addDownloadedSong(db: GenericDb, songId: string): Promise<void> {
    const existing = await db.select({ songId: downloadedSongTable.songId }).from(downloadedSongTable)
        .where(eq(downloadedSongTable.songId, songId)).limit(1);

    if (existing.length) {
        return;
    }

    await db.insert(downloadedSongTable).values({
        downloadedSongId: generateId(),
        songId: songId
    });
}

// Clears the "downloaded" flag for the given songs (e.g. after their audio was replaced server-side, so the
// stale local file no longer matches). Idempotent: a no-op for songs that weren't marked downloaded.
export async function removeDownloadedSongs(db: GenericDb, songIds: string[]): Promise<void> {
    if (!songIds.length) {
        return;
    }
    for (const idChunk of chunkIds(songIds)) {
        await db.delete(downloadedSongTable).where(inArray(downloadedSongTable.songId, idChunk));
    }
}
