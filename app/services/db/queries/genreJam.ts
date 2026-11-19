import { GenericDb } from "../GenericDb";
import { GenreJam } from "../models";
import { genreJamTable } from "../schema";
import { withTransaction } from "../transaction";
import { addRequests } from "./request";
import { RequestType } from "@/app/enums";
import { generateId } from "@/app/tools/pure";
import { and, asc, eq, inArray } from "drizzle-orm";

// Genre Jams sync like the rest of the user's data (ShuffullApp#214): a save or delete changes the local row AND
// queues the request that tells the server, in one transaction, and each sync replaces the local jams with the
// server's list plus whatever is still queued (mergeGenreJams).

export async function getGenreJam(db: GenericDb, userId: string, genreJamId: string): Promise<GenreJam | undefined> {
    const genreJam = await db.select().from(genreJamTable)
        .where(and(eq(genreJamTable.userId, userId), eq(genreJamTable.genreJamId, genreJamId)));

    if (!genreJam.length) {
        return undefined;
    }

    return genreJam[0];
}

export async function getGenreJams(db: GenericDb, userId: string): Promise<GenreJam[]> {
    return await db.select().from(genreJamTable)
        .where(eq(genreJamTable.userId, userId))
        .orderBy(asc(genreJamTable.name), asc(genreJamTable.genreJamId));
}

/** Creates or replaces a jam on this device and queues the same save for the server. */
export async function saveGenreJam(db: GenericDb, jam: GenreJam): Promise<void> {
    await withTransaction(db, async tx => {
        await tx.insert(genreJamTable).values([jam]).onConflictDoUpdate({
            target: genreJamTable.genreJamId,
            set: {
                userId: jam.userId,
                name: jam.name,
                whitelists: jam.whitelists,
                blacklists: jam.blacklists,
                heavinessMin: jam.heavinessMin,
                heavinessMax: jam.heavinessMax,
            },
        });
        await addRequests(tx, [{
            requestId: generateId(),
            timeRequested: new Date(),
            requestType: RequestType.SaveGenreJam,
            userId: jam.userId,
            payload: {
                genreJamId: jam.genreJamId,
                name: jam.name,
                whitelists: jam.whitelists,
                blacklists: jam.blacklists,
                heavinessMin: jam.heavinessMin,
                heavinessMax: jam.heavinessMax,
            },
        }]);
    });
}

/** Deletes a jam on this device and queues the delete for the server. */
export async function deleteGenreJam(db: GenericDb, userId: string, genreJamId: string): Promise<void> {
    await withTransaction(db, async tx => {
        await tx.delete(genreJamTable)
            .where(and(eq(genreJamTable.userId, userId), eq(genreJamTable.genreJamId, genreJamId)));
        await addRequests(tx, [{
            requestId: generateId(),
            timeRequested: new Date(),
            requestType: RequestType.DeleteGenreJam,
            userId,
            payload: { genreJamId },
        }]);
    });
}

/** The sync's write: the user's jams become exactly `jams`. Queues nothing. */
export async function replaceGenreJams(db: GenericDb, userId: string, jams: GenreJam[]): Promise<void> {
    await db.delete(genreJamTable).where(eq(genreJamTable.userId, userId));
    if (jams.length == 0) {
        return;
    }
    // A jam id is unique on its own, so a row another account left on this device under one of these ids gives way.
    await db.delete(genreJamTable).where(inArray(genreJamTable.genreJamId, jams.map(x => x.genreJamId)));
    await db.insert(genreJamTable).values(jams);
}
