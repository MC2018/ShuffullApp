import { GenericDb } from "../GenericDb";
import { DeadLetterRequest, Request, RetagModel, SongRetagPayload } from "../models";
import { deadLetterRequestTable, requestTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { RequestType } from "@/app/enums";
import { generateId } from "@/app/tools/pure";
import { chunkIds, chunkRows } from "./_chunk";
import { withTransaction } from "../transaction";

// An outbox row is a user decision (a Keep, a like, a delete) waiting to be pushed, so each write of one is its own
// transaction: one queued while sync is writing waits for it, rather than being rolled back with it (transaction.ts).
export async function addRequests(db: GenericDb, requests: Request[]): Promise<void> {
    await withTransaction(db, async tx => {
        // The outbox flushes in bursts (a batch of Keeps/likes), so this is chunked too (see _chunk.ts).
        for (const rowChunk of chunkRows(requests)) {
            await tx.insert(requestTable).values(rowChunk);
        }
    });
}

// Enqueues a re-tag for a song, maintaining ONE pending row per song and user with STRONGER-WINS: a Like queued
// after a Keep upgrades the pending row weak -> strong (one AI run at the right tier, and the
// Keep-then-Like-before-sync race can't strand a liked song on weak tags); the reverse never downgrades.
// Its own transaction, like addRequests, which also keeps the read and the write below together.
export async function enqueueSongRetag(db: GenericDb, userId: string, songId: string, model: RetagModel): Promise<void> {
    await withTransaction(db, tx => enqueueSongRetagIn(tx, userId, songId, model));
}

async function enqueueSongRetagIn(db: GenericDb, userId: string, songId: string, model: RetagModel): Promise<void> {
    const existing = await db.select().from(requestTable)
        .where(and(
            eq(requestTable.requestType, RequestType.SongRetag),
            eq(requestTable.userId, userId),
            eq(requestTable.songId, songId)));

    if (existing.length > 0) {
        const current = (existing[0].payload as SongRetagPayload | null)?.model ?? "strong";
        if (current === "weak" && model === "strong") {
            // A new row under a new id, never an update in place. sync() deletes what it sent by requestId once the
            // server answers, so a row upgraded while its weak version was in flight used to be deleted unsent, and
            // the Like's strong re-tag was lost. The old id now matches nothing; the strong row goes on the next
            // flush. It keeps the original time, and so its place in the queue.
            await db.delete(requestTable).where(eq(requestTable.requestId, existing[0].requestId));
            await db.insert(requestTable).values([{ ...existing[0], requestId: generateId(), payload: { model: "strong" } }]);
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

// One user's outbox, oldest first. The order is the order the user acted in: a like then an unlike must reach the
// server in that order, and a user song must exist before its like or play. Rows queued in the same millisecond keep
// their insertion order (rowid). Filtered by user because the outbox outlives a logout: another account signed in
// on the same device must not send the first one's rows with its own token. They wait for their owner instead.
export async function getRequests(db: GenericDb, userId: string): Promise<Request[]> {
    return await db.select().from(requestTable)
        .where(eq(requestTable.userId, userId))
        .orderBy(asc(requestTable.timeRequested), sql`rowid`);
}

export async function deleteRequests(db: GenericDb, requestIds: string[]): Promise<void> {
    for (const idChunk of chunkIds(requestIds)) {
        await db.delete(requestTable).where(inArray(requestTable.requestId, idChunk));
    }
}

// The dead-letter row for an outbox request: its key columns, the reason, and the whole original row.
export function deadLetterRow(request: Request, reason: string, now: Date): typeof deadLetterRequestTable.$inferInsert {
    return {
        requestId: request.requestId,
        requestType: request.requestType,
        userId: request.userId,
        songId: request.songId ?? null,
        playlistId: request.playlistId ?? null,
        timeRequested: request.timeRequested,
        deadLetteredAt: now,
        reason,
        request,
    };
}

// Moves outbox rows to the dead-letter table, each with its reason. Inserted BEFORE the outbox delete and with
// insert-or-ignore, so neither order of failure can lose a row: a crash in between leaves it in both tables, and
// the next attempt skips the existing dead-letter row and finishes the delete.
export async function deadLetterRequests(db: GenericDb, failures: { request: Request; reason: string }[], now: Date = new Date()): Promise<void> {
    if (!failures.length) {
        return;
    }

    const rows = failures.map(({ request, reason }) => deadLetterRow(request, reason, now));
    for (const rowChunk of chunkRows(rows)) {
        await db.insert(deadLetterRequestTable).values(rowChunk).onConflictDoNothing();
    }

    await deleteRequests(db, failures.map(x => x.request.requestId));
}

export async function getDeadLetterRequests(db: GenericDb, userId: string): Promise<DeadLetterRequest[]> {
    return await db.select().from(deadLetterRequestTable).where(eq(deadLetterRequestTable.userId, userId));
}

// Clears dead-lettered Keeps the server has since recorded, which lifts any playlist delete they were holding.
export async function removeDeadLetteredKeeps(db: GenericDb, userId: string, songIds: string[]): Promise<void> {
    for (const idChunk of chunkIds(songIds)) {
        await db.delete(deadLetterRequestTable).where(and(
            eq(deadLetterRequestTable.userId, userId),
            eq(deadLetterRequestTable.requestType, RequestType.SongRetag),
            inArray(deadLetterRequestTable.songId, idChunk)));
    }
}

// TODO: move all requests from SyncManager to here