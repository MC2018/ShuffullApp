import { DownloadPriority } from "@/app/tools";
import { GenericDb } from "../GenericDb";
import { downloadQueueTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { DownloadQueue } from "../models";

// TODO: I may want to add a way to change priority
export async function addToDownloadQueue(db: GenericDb, songIds: number[], priority: DownloadPriority): Promise<void> {
    if (!songIds.length) {
        return;
    }

    await db.insert(downloadQueueTable).values(songIds.map(x => ({
        songId: x,
        priority: priority
    }))).onConflictDoNothing();
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

export async function removeFromDownloadQueue(db: GenericDb, songId: number): Promise<void> {
    await db.delete(downloadQueueTable).where(eq(downloadQueueTable.songId, songId));
}
