import { generateId } from "@/app/tools";
import { GenericDb } from "../GenericDb";
import { downloadQueueTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { DownloadQueue } from "../models";
import { DownloadPriority } from "../types";
import { chunkRows } from "./_chunk";

// TODO: I may want to add a way to change priority
export async function addToDownloadQueue(db: GenericDb, songIds: string[], priority: DownloadPriority): Promise<void> {
    if (!songIds.length) {
        return;
    }

    // "Download all" can enqueue the whole library at once, so this is chunked too (see _chunk.ts).
    const rows = songIds.map(x => ({
        downloadQueueId: generateId(),
        songId: x,
        priority: priority
    }));

    for (const rowChunk of chunkRows(rows)) {
        await db.insert(downloadQueueTable).values(rowChunk).onConflictDoNothing();
    }
}

export async function getFromDownloadQueue(db: GenericDb): Promise<DownloadQueue | undefined> {
    const result = await db.select().from(downloadQueueTable)
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
