import { GenericDb } from "../GenericDb";
import { User } from "../models";
import { userTable } from "../schema";
import { eq, ne } from "drizzle-orm";

export async function updateUser(db: GenericDb, newUser: User): Promise<void> {
    await db.delete(userTable).where(eq(userTable.userId, newUser.userId));
    await db.insert(userTable).values([
        newUser
    ]);
}

export async function getUser(db: GenericDb, userId: string): Promise<User | undefined> {
    const user = await db.select().from(userTable).where(eq(userTable.userId, userId)).limit(1);

    if (user.length == 0) {
        return undefined;
    }

    return user[0];
}

export async function getUsers(db: GenericDb): Promise<User[]> {
    const users = await db.select().from(userTable);

    return users;
}

// Whether any account other than `userId` has synced on this device.
export async function hasOtherUser(db: GenericDb, userId: string): Promise<boolean> {
    const others = await db.select({ userId: userTable.userId }).from(userTable).where(ne(userTable.userId, userId)).limit(1);
    return others.length > 0;
}

// Sets every account's user-songs feed position (users.version). FEED_START makes each account's next sync page its
// whole library again, as on a first sync.
export async function setAllUserVersions(db: GenericDb, version: Date): Promise<void> {
    await db.update(userTable).set({ version });
}
