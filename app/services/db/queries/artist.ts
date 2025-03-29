import { DownloadPriority } from "@/app/tools";
import { GenericDb } from "../GenericDb";
import { artistTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { Artist } from "../models";

export async function updateArtists(db: GenericDb, artists: Artist[]): Promise<void> {
    await db.insert(artistTable).values(artists).onConflictDoUpdate({
        target: artistTable.artistId,
        set: {
            name: sql`excluded.name`
        }
    });
}

export async function getArtists(db: GenericDb): Promise<Artist[]> {
    return await db.select().from(artistTable);
}
