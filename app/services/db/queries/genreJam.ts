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
