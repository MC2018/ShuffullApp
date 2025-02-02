import { GenericDb } from "../GenericDb";
import { Request } from "../models";
import { requestTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function addRequest(db: GenericDb, request: Request) {
    await db.insert(requestTable).values([request]);
}

// TODO: move all requests from SyncManager to here