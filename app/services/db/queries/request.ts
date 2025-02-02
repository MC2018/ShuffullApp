import { GenericDb } from "../GenericDb";
import { Request } from "../models";
import { requestTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function addRequests(db: GenericDb, requests: Request[]): Promise<void> {
    await db.insert(requestTable).values(requests);
}

export async function getRequests(db: GenericDb): Promise<Request[]> {
    return await db.select().from(requestTable);
}

export async function deleteRequests(db: GenericDb, requestGuids: string[]): Promise<void> {
    await db.delete(requestTable).where(inArray(requestTable.requestGuid, requestGuids));
}

// TODO: move all requests from SyncManager to here