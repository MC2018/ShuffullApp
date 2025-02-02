import { DownloadPriority } from "@/app/tools/DownloadManager";
import { GenericDb } from "../GenericDb";
import { downloadQueueTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

// TODO: I may want to add a way to change priority
export async function addToDownloadQueue(db: GenericDb, songIds: number[], priority: DownloadPriority) {
    if (!songIds.length) {
        return;
    }

    await db.insert(downloadQueueTable).values(songIds.map(x => ({
        songId: x,
        priority: priority
    }))).onConflictDoNothing();
}

export async function getFromDownloadQueue(db: GenericDb) {
    const result = await db.select().from(downloadQueueTable)
        .orderBy(desc(downloadQueueTable.priority), asc(downloadQueueTable.downloadQueueId))
        .limit(1);

    if (!result.length) {
        return undefined;
    }

    return result[0];
}

export async function removeFromDownloadQueue(db: GenericDb, songId: number) {
    await db.delete(downloadQueueTable).where(eq(downloadQueueTable.songId, songId));
}
