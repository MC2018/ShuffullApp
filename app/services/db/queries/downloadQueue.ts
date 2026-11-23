import { generateId } from "@/app/tools/pure";
import { GenericDb } from "../GenericDb";
import { artistTable, downloadedSongTable, downloadQueueTable, songArtistTable, songTable } from "../schema";
import { eq, desc, asc, count, sql } from "drizzle-orm";
import { DownloadQueue } from "../models";
import { DownloadPriority, SongDetails } from "../types";
import { DownloadSource } from "@/app/tools/autoDownloads";
import { chunkRows } from "./_chunk";

/**
 * Queues songs. A hand-picked (`manual`, the default) add of a song the auto-download rules already queued takes it
 * over: the row becomes manual, so the rules can't remove it, and keeps the higher of the two priorities. An `auto` add
 * never touches a row that is already there.
 */
export async function addToDownloadQueue(db: GenericDb, songIds: string[], priority: DownloadPriority, source: DownloadSource = "manual"): Promise<void> {
    if (!songIds.length) {
        return;
    }

    // "Download all" can enqueue the whole library at once, so this is chunked too (see _chunk.ts).
    const rows = songIds.map(x => ({
        downloadQueueId: generateId(),
        songId: x,
        priority: priority,
        source,
    }));

    for (const rowChunk of chunkRows(rows)) {
        const insert = db.insert(downloadQueueTable).values(rowChunk);
        if (source === "manual") {
            await insert.onConflictDoUpdate({
                target: downloadQueueTable.songId,
                set: { source: "manual", priority: sql`max(${downloadQueueTable.priority}, excluded.priority)` },
            });
        } else {
            await insert.onConflictDoNothing();
        }
    }
}

/** The row the Downloader takes next: highest priority first, then oldest. `source` narrows it to one kind of row. */
export async function getFromDownloadQueue(db: GenericDb, source?: DownloadSource): Promise<DownloadQueue | undefined> {
    const result = await db.select().from(downloadQueueTable)
        .where(source == undefined ? undefined : eq(downloadQueueTable.source, source))
        .orderBy(desc(downloadQueueTable.priority), asc(downloadQueueTable.downloadQueueId))
        .limit(1);

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

export async function removeFromDownloadQueue(db: GenericDb, songId: string): Promise<void> {
    await db.delete(downloadQueueTable).where(eq(downloadQueueTable.songId, songId));
}

// Sends a row to the back of its priority tier without losing it. The queue is read in download_queue_id order and
// ids are ULIDs (time-prefixed), so a fresh id sorts after every row already queued.
export async function moveToBackOfDownloadQueue(db: GenericDb, songId: string): Promise<void> {
    await db.update(downloadQueueTable).set({ downloadQueueId: generateId() }).where(eq(downloadQueueTable.songId, songId));
}

export async function removeAllFromDownloadQueue(db: GenericDb): Promise<void> {
    await db.delete(downloadQueueTable);
}

export async function isSongInDownloadQueue(db: GenericDb, songId: string): Promise<boolean> {
    const rows = await db.select({ songId: downloadQueueTable.songId }).from(downloadQueueTable)
        .where(eq(downloadQueueTable.songId, songId)).limit(1);
    return rows.length > 0;
}

export async function countDownloadQueue(db: GenericDb): Promise<number> {
    const rows = await db.select({ n: count() }).from(downloadQueueTable);
    return rows[0]?.n ?? 0;
}

export async function countDownloadedSongs(db: GenericDb): Promise<number> {
    const rows = await db.select({ n: count() }).from(downloadedSongTable);
    return rows[0]?.n ?? 0;
}

// The queue in the order the Downloader will take it (same ORDER BY as getFromDownloadQueue), joined to
// song + artists for display. `limit` bounds the join — the Downloads screen shows the head of the queue
// with a "+N more" line rather than rendering a whole enqueued library.
export async function getDownloadQueueDetails(db: GenericDb, limit: number): Promise<SongDetails[]> {
    const head = await db.select({ songId: downloadQueueTable.songId }).from(downloadQueueTable)
        .orderBy(desc(downloadQueueTable.priority), asc(downloadQueueTable.downloadQueueId))
        .limit(limit);

    if (!head.length) {
        return [];
    }

    const order = new Map(head.map((row, i) => [row.songId, i]));
    const rawData = await db
        .select({ song: songTable, artist: artistTable })
        .from(downloadQueueTable)
        .innerJoin(songTable, eq(songTable.songId, downloadQueueTable.songId))
        .leftJoin(songArtistTable, eq(songTable.songId, songArtistTable.songId))
        .leftJoin(artistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .orderBy(desc(downloadQueueTable.priority), asc(downloadQueueTable.downloadQueueId))
        .limit(limit * 8); // generous: a song rarely has more than a handful of artists

    const bySong = new Map<string, SongDetails>();
    for (const row of rawData) {
        if (!order.has(row.song.songId)) {
            continue;
        }
        let details = bySong.get(row.song.songId);
        if (!details) {
            details = { song: row.song, artists: [] };
            bySong.set(row.song.songId, details);
        }
        if (row.artist != null) {
            details.artists.push(row.artist);
        }
    }

    return [...bySong.values()].sort((a, b) => order.get(a.song.songId)! - order.get(b.song.songId)!);
}
