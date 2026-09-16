import { GenericDb } from "../GenericDb";
import { LocalSessionData } from "../models";
import { localSessionDataTable, userTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function getLocalSessionData(db: GenericDb, userId: string): Promise<LocalSessionData | undefined> {
    const result = await db.select().from(localSessionDataTable).where(eq(localSessionDataTable.userId, userId)).limit(1);

    if (result.length) {
        return result[0];
    }

    return undefined;
}

export async function getActiveLocalSessionData(db: GenericDb): Promise<LocalSessionData | undefined> {
    // Pick the session that is still valid (expiration in the future) and, when several accounts
    // have been used on this device, the most recently issued one. Ordering by expiration desc
    // surfaces the freshest token (tokens are issued with a fixed lifetime, so the latest login
    // has the furthest-out expiration). Without this the query returned an arbitrary row, which
    // could be a logged-out or stale token from a different server/environment and get rejected
    // with a 401.
    const result = await db.select().from(localSessionDataTable)
        .where(gt(localSessionDataTable.expiration, new Date()))
        .orderBy(desc(localSessionDataTable.expiration))
        .limit(1);

    if (result.length) {
        return result[0];
    }

    return undefined;
}
