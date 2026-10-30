import { eq } from "drizzle-orm";
import { RequestType } from "@/app/enums";
import { GenericDb } from "../GenericDb";
import { OpenListen, RecordListenPayload, RecordListenRequest } from "../models";
import { listenTable, requestTable } from "../schema";
import { withTransaction } from "../transaction";

// Writes or refreshes the open listen's checkpoint. Plain db, not a transaction of its own: a checkpoint caught in a
// sync's rollback is just rewritten by the next one, and closing a listen doesn't need its row (closeListen).
export async function saveOpenListen(db: GenericDb, listen: OpenListen): Promise<void> {
    await db.insert(listenTable).values(listen).onConflictDoUpdate({
        target: listenTable.listenId,
        set: {
            secondsListened: listen.secondsListened,
            songDurationSeconds: listen.songDurationSeconds,
            checkpointedAt: listen.checkpointedAt,
        },
    });
}

export async function getOpenListens(db: GenericDb): Promise<OpenListen[]> {
    return await db.select().from(listenTable);
}

// Closes a listen: drops its open row and queues the finished listen in the outbox, together, so a crash can neither
// lose it nor leave it open to be recovered and sent twice. The outbox row's id is the listen's, so a second close of
// the same listen is ignored here, and a resend after a lost response comes back "duplicate" from the server.
export async function closeListen(db: GenericDb, listen: RecordListenPayload, now: Date = new Date()): Promise<void> {
    const request: RecordListenRequest = {
        requestId: listen.listenId,
        timeRequested: now,
        requestType: RequestType.RecordListen,
        userId: listen.userId,
        songId: listen.songId,
        payload: listen,
    };

    await withTransaction(db, async tx => {
        await tx.delete(listenTable).where(eq(listenTable.listenId, listen.listenId));
        await tx.insert(requestTable).values(request).onConflictDoNothing();
    });
}
