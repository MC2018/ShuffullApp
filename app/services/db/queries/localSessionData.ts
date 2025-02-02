import { GenericDb } from "../GenericDb";
import { localSessionDataTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function getLocalSessionData(db: GenericDb, userId: number) {
    const result = await db.select().from(localSessionDataTable).where(eq(localSessionDataTable.userId, userId)).limit(1);

    if (result.length) {
        return result[0];
    }

    return undefined;
}

export async function getActiveLocalSessionData(db: GenericDb) {
    const result = await db.select().from(localSessionDataTable).where(isNotNull(localSessionDataTable.expiration)).limit(1);

    if (result.length) {
        return result[0];
    }

    return undefined;
}

export async function setActiveLocalSessionPlaylistId(db: GenericDb, playlistId: number) {
    await db.update(localSessionDataTable).set({currentPlaylistId: playlistId});
}
