import { GenericDb } from "../GenericDb";
import { Request, RetagModel, SongRetagPayload } from "../models";
import { requestTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { RequestType } from "@/app/enums";
import { generateId } from "@/app/tools/pure";
import { chunkIds, chunkRows } from "./_chunk";

export async function addRequests(db: GenericDb, requests: Request[]): Promise<void> {
    // The outbox flushes in bursts (a batch of Keeps/likes), so this is chunked too (see _chunk.ts).
    for (const rowChunk of chunkRows(requests)) {
        await db.insert(requestTable).values(rowChunk);
    }
}

// Enqueues a re-tag for a song, maintaining ONE pending row per song with STRONGER-WINS: a Like queued
// after a Keep upgrades the pending row weak -> strong (one AI run at the right tier, and the
// Keep-then-Like-before-sync race can't strand a liked song on weak tags); the reverse never downgrades.
export async function enqueueSongRetag(db: GenericDb, userId: string, songId: string, model: RetagModel): Promise<void> {
    const existing = await db.select().from(requestTable)
        .where(and(eq(requestTable.requestType, RequestType.SongRetag), eq(requestTable.songId, songId)));

    if (existing.length > 0) {
        const current = (existing[0].payload as SongRetagPayload | null)?.model ?? "strong";
        if (current === "weak" && model === "strong") {
            await db.update(requestTable)
                .set({ payload: { model: "strong" } })
                .where(eq(requestTable.requestId, existing[0].requestId));
        }
        return; // already queued at an equal-or-stronger tier
    }

    await db.insert(requestTable).values([{
        requestId: generateId(),
        timeRequested: new Date(),
        requestType: RequestType.SongRetag,
        userId,
        songId,
        payload: { model },
    }]);
}

export async function getRequests(db: GenericDb): Promise<Request[]> {
    return await db.select().from(requestTable);
}

export async function deleteRequests(db: GenericDb, requestIds: string[]): Promise<void> {
    for (const idChunk of chunkIds(requestIds)) {
        await db.delete(requestTable).where(inArray(requestTable.requestId, idChunk));
    }
}

// TODO: move all requests from SyncManager to here