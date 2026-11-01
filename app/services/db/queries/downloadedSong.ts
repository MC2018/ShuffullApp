import { generateId } from "@/app/tools/pure";
import { GenericDb } from "../GenericDb";
import { downloadedSongTable, songTable } from "../schema";
import { eq, inArray } from "drizzle-orm";
import { chunkIds, chunkRows } from "./_chunk";

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

// Bulk addDownloadedSong, for the disk reconcile: a rebuilt DB next to a full music folder can record the whole
// library at once. Same idempotence: songs that already have a row are skipped.
export async function addDownloadedSongs(db: GenericDb, songIds: string[]): Promise<void> {
    const existing = new Set<string>();
    for (const idChunk of chunkIds(songIds)) {
        const rows = await db.select({ songId: downloadedSongTable.songId }).from(downloadedSongTable)
            .where(inArray(downloadedSongTable.songId, idChunk));
        rows.forEach(x => existing.add(x.songId));
    }

    const rows = [...new Set(songIds)].filter(x => !existing.has(x)).map(x => ({ downloadedSongId: generateId(), songId: x }));
    for (const rowChunk of chunkRows(rows)) {
        await db.insert(downloadedSongTable).values(rowChunk);
    }
}

// Every local song with the parts its file name is built from and whether it has a downloaded_songs row - the input
// to the disk reconcile (tools/downloadReconcile.ts). One row per song even if the table holds duplicates.
export async function getSongFileStates(db: GenericDb): Promise<{ songId: string; fileHash: string; fileExtension: string; downloaded: boolean }[]> {
    const rows = await db.selectDistinct({
        songId: songTable.songId,
        fileHash: songTable.fileHash,
        fileExtension: songTable.fileExtension,
        downloadedRow: downloadedSongTable.songId,
    }).from(songTable)
        .leftJoin(downloadedSongTable, eq(downloadedSongTable.songId, songTable.songId));
    return rows.map(({ downloadedRow, ...x }) => ({ ...x, downloaded: downloadedRow != null }));
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
