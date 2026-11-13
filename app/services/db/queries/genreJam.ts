import { GenericDb } from "../GenericDb";
import { GenreJam, OwnedGenreJam } from "../models";
import { genreJamTable } from "../schema";
import { and, eq, asc, isNull } from "drizzle-orm";

// Every jam belongs to the account that made it (ShuffullApp#199). Reads, updates and deletes take that account, so
// one account on a shared device never sees or changes another's.

export async function addGenreJam(db: GenericDb, genreJam: OwnedGenreJam): Promise<void> {
    await db.insert(genreJamTable).values([genreJam]).onConflictDoNothing();
}

export async function getGenreJam(db: GenericDb, userId: string, genreJamId: string): Promise<GenreJam | undefined> {
    const genreJam = await db
        .select()
        .from(genreJamTable)
        .where(and(eq(genreJamTable.genreJamId, genreJamId), eq(genreJamTable.userId, userId)));

    if (!genreJam.length) {
        return undefined;
    }

    return genreJam[0];
}

export async function getGenreJams(db: GenericDb, userId: string): Promise<GenreJam[]> {
    return await db.select().from(genreJamTable).where(eq(genreJamTable.userId, userId)).orderBy(asc(genreJamTable.name));
}

export async function updateGenreJam(db: GenericDb, genreJam: OwnedGenreJam): Promise<void> {
    await db
        .update(genreJamTable)
        .set({
            name: genreJam.name,
            whitelists: genreJam.whitelists,
            blacklists: genreJam.blacklists,
            heavinessMin: genreJam.heavinessMin,
            heavinessMax: genreJam.heavinessMax,
        })
        .where(and(eq(genreJamTable.genreJamId, genreJam.genreJamId), eq(genreJamTable.userId, genreJam.userId)));
}

export async function deleteGenreJam(db: GenericDb, userId: string, genreJamId: string): Promise<void> {
    await db.delete(genreJamTable).where(and(eq(genreJamTable.genreJamId, genreJamId), eq(genreJamTable.userId, userId)));
}

/**
 * Hands every jam with no account to `userId`. A jam made before ShuffullApp#199 has none, and neither has one a
 * database rebuild carried over from that older schema (recovery.ts). Until it has one, no account sees it, so this
 * runs at every login and session restore, before the device's owner can change. Idempotent: once every jam is
 * owned, it changes nothing.
 */
export async function claimUnownedGenreJams(db: GenericDb, userId: string): Promise<void> {
    await db.update(genreJamTable).set({ userId }).where(isNull(genreJamTable.userId));
}
