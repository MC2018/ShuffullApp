import { GenericDb } from "../GenericDb";
import { User } from "../models";
import { userTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function updateUser(db: GenericDb, newUser: User) {
    await db.delete(userTable).where(eq(userTable.userId, newUser.userId));
    await db.insert(userTable).values([
        newUser
    ]);
}
