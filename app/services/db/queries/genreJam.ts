import { GenericDb } from "../GenericDb";
import { GenreJam } from "../models";
import { genreJamTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function addGenreJam(db: GenericDb, genreJam: GenreJam): Promise<void> {
    await db.insert(genreJamTable).values([genreJam]).onConflictDoNothing();
}

export async function getGenreJam(db: GenericDb, genreJamId: string): Promise<GenreJam | undefined> {
    const genreJam = await db.select().from(genreJamTable).where(eq(genreJamTable.genreJamId, genreJamId));

    if (!genreJam.length) {
        return undefined;
    }

    return genreJam[0];
}

export async function getGenreJams(db: GenericDb): Promise<GenreJam[]> {
    return await db.select().from(genreJamTable).orderBy(asc(genreJamTable.name));
}

export async function updateGenreJam(db: GenericDb, genreJam: GenreJam): Promise<void> {
    await db
        .update(genreJamTable)
        .set({
            name: genreJam.name,
            whitelists: genreJam.whitelists,
            blacklists: genreJam.blacklists,
            energyMin: genreJam.energyMin,
            energyMax: genreJam.energyMax,
        })
        .where(eq(genreJamTable.genreJamId, genreJam.genreJamId));
}

export async function deleteGenreJam(db: GenericDb, genreJamId: string): Promise<void> {
    await db.delete(genreJamTable).where(eq(genreJamTable.genreJamId, genreJamId));
}
