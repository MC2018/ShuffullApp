import { generateId } from "@/app/tools/pure";
import { GenericDb } from "../GenericDb";
import { downloadedSongTable, songTable } from "../schema";
import { eq, inArray, sql } from "drizzle-orm";
import { chunkIds, chunkRows } from "./_chunk";

// Idempotent: downloaded_songs has no unique constraint on song_id, and more than one path records a song (the
// download itself, a file found already on disk, the disk reconcile - ShuffullApp#56), so a second call must not add
// a duplicate row: every join on this table would then return the song twice.
export async function addDownloadedSong(db: GenericDb, songId: string): Promise<void> {
    await addDownloadedSongs(db, [songId]);
}

// Bulk addDownloadedSong, for the disk reconcile: a rebuilt DB next to a full music folder can record the whole
// library at once. Each chunk is ONE statement that skips songs already holding a row, rather than a select and then
// an insert: the reconcile and the download loop can record the same song at once, and with an await between the
// check and the insert both would see no row and both would add one.
export async function addDownloadedSongs(db: GenericDb, songIds: string[]): Promise<void> {
    const rows = [...new Set(songIds)].map(x => ({ downloadedSongId: generateId(), songId: x }));
    for (const rowChunk of chunkRows(rows)) {
        const values = sql.join(rowChunk.map(x => sql`(${x.downloadedSongId}, ${x.songId})`), sql`, `);
        await db.run(sql`
            INSERT INTO ${downloadedSongTable} (downloaded_song_id, song_id)
            SELECT v.column1, v.column2 FROM (VALUES ${values}) v
            WHERE NOT EXISTS (SELECT 1 FROM ${downloadedSongTable} d WHERE d.song_id = v.column2)`);
    }
}

// Every local song with the parts its file name is built from and whether it has a downloaded_songs row - the input
// to the disk reconcile (tools/downloadReconcile.ts). One row per song even if the table holds duplicates.
export async function getSongDownloadRows(db: GenericDb): Promise<{ songId: string; fileHash: string; fileExtension: string; downloaded: boolean }[]> {
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
