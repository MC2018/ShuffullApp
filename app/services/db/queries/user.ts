import { GenericDb } from "../GenericDb";
import { User } from "../models";
import { userTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function updateUser(db: GenericDb, newUser: User): Promise<void> {
    await db.delete(userTable).where(eq(userTable.userId, newUser.userId));
    await db.insert(userTable).values([
        newUser
    ]);
}

export async function getUser(db: GenericDb, userId: number): Promise<User | undefined> {
    const user = await db.select().from(userTable).where(eq(userTable.userId, userId)).limit(1);

    if (user.length == 0) {
        return undefined;
    }

    return user[0];
}