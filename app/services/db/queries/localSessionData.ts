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
    const result = await db.select().from(localSessionDataTable).where(isNotNull(localSessionDataTable.expiration)).limit(1);

    if (result.length) {
        return result[0];
    }

    return undefined;
}
