import { generateId } from "@/app/tools/pure";
import { GenericDb } from "../GenericDb";
import { downloadedSongTable, downloadQueueTable } from "../schema";
import { withTransaction } from "../transaction";
import { and, eq, inArray } from "drizzle-orm";
import { DownloadSource } from "@/app/tools/autoDownloads";
import { chunkIds } from "./_chunk";

// Idempotent: downloaded_songs has no unique constraint on song_id, and the Downloader also records songs it
// finds already on disk (a run that moved the file but died before getting here), so a second call must not
// add a duplicate row - every join on this table would then return the song twice.
// `source` says who asked for it (ShuffullApp#225). A manual record of a song the rules downloaded takes it over;
// an auto record never downgrades a manual one.
export async function addDownloadedSong(db: GenericDb, songId: string, source: DownloadSource = "manual"): Promise<void> {
    const existing = await db.select({ songId: downloadedSongTable.songId, source: downloadedSongTable.source }).from(downloadedSongTable)
        .where(eq(downloadedSongTable.songId, songId)).limit(1);

    if (existing.length) {
        if (source === "manual" && existing[0].source !== "manual") {
            await markDownloadsManual(db, [songId]);
        }
        return;
    }

    await db.insert(downloadedSongTable).values({
        downloadedSongId: generateId(),
        songId: songId,
        source,
    });
}

/**
 * A queued song's file has landed: record it as downloaded and drop its queue row, in one transaction. The source is
 * read from the queue row now, not when the download started, because a hand-picked add can take an auto row over
 * while its file is in flight. With the row already gone (removed while in flight), `fallbackSource` is used.
 */
export async function recordQueuedDownload(db: GenericDb, songId: string, fallbackSource: DownloadSource): Promise<void> {
    await withTransaction(db, async (tx) => {
        const row = await tx.select({ source: downloadQueueTable.source }).from(downloadQueueTable)
            .where(eq(downloadQueueTable.songId, songId)).limit(1);
        await addDownloadedSong(tx, songId, row[0]?.source ?? fallbackSource);
        await tx.delete(downloadQueueTable).where(eq(downloadQueueTable.songId, songId));
    });
}

// The user asked for these songs by hand, and some are already downloaded by the auto-download rules: they are the
// user's now, and the rules will never remove them.
export async function markDownloadsManual(db: GenericDb, songIds: string[]): Promise<void> {
    for (const idChunk of chunkIds(songIds)) {
        await db.update(downloadedSongTable).set({ source: "manual" })
            .where(and(inArray(downloadedSongTable.songId, idChunk), eq(downloadedSongTable.source, "auto")));
    }
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
