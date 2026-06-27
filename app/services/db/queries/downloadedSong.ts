import { generateId } from "@/app/tools";
import { GenericDb } from "../GenericDb";
import { downloadedSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { DownloadQueue } from "../models";

export async function addDownloadedSong(db: GenericDb, songId: string): Promise<void> {
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
    await db.delete(downloadedSongTable).where(inArray(downloadedSongTable.songId, songIds));
}
