import { GenericDb } from "../GenericDb";
import { artistTable, songArtistTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { Artist } from "../models";

export interface ArtistWithCount {
    artistId: string;
    name: string;
    songCount: number;
}

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

export async function getArtist(db: GenericDb, artistId: string): Promise<Artist | undefined> {
    const rows = await db.select().from(artistTable).where(eq(artistTable.artistId, artistId));
    return rows.length ? rows[0] : undefined;
}

// Artists that have at least one local song, with how many, ordered by name — for the Artists browse list.
export async function getArtistsWithCounts(db: GenericDb): Promise<ArtistWithCount[]> {
    return await db
        .select({
            artistId: artistTable.artistId,
            name: artistTable.name,
            songCount: sql<number>`count(${songArtistTable.songId})`,
        })
        .from(artistTable)
        .innerJoin(songArtistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .groupBy(artistTable.artistId)
        .orderBy(asc(artistTable.name));
}
