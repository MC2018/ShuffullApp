import { GenericDb } from "../GenericDb";
import { artistTable, songArtistTable } from "../schema";
import { eq, sql, asc } from "drizzle-orm";
import { Artist } from "../models";
import { chunkRows } from "./_chunk";
import { notHiddenAsDuplicate } from "./duplicateReport";

export interface ArtistWithCount {
    artistId: string;
    name: string;
    songCount: number;
}

export async function updateArtists(db: GenericDb, artists: Artist[]): Promise<void> {
    // Grows with the number of songs synced, so it is chunked like the other bulk writes (see _chunk.ts).
    for (const rowChunk of chunkRows(artists)) {
        await db.insert(artistTable).values(rowChunk).onConflictDoUpdate({
            target: artistTable.artistId,
            set: {
                name: sql`excluded.name`
            }
        });
    }
}

export async function getArtists(db: GenericDb): Promise<Artist[]> {
    return await db.select().from(artistTable);
}

export async function getArtist(db: GenericDb, artistId: string): Promise<Artist | undefined> {
    const rows = await db.select().from(artistTable).where(eq(artistTable.artistId, artistId));
    return rows.length ? rows[0] : undefined;
}

// Artists that have at least one local song, with how many, ordered by name — for the Artists browse list. Songs the
// user hid as duplicates don't count, so an artist whose only song is hidden drops off the list.
export async function getArtistsWithCounts(db: GenericDb, userId: string): Promise<ArtistWithCount[]> {
    return await db
        .select({
            artistId: artistTable.artistId,
            name: artistTable.name,
            songCount: sql<number>`count(${songArtistTable.songId})`,
        })
        .from(artistTable)
        .innerJoin(songArtistTable, eq(songArtistTable.artistId, artistTable.artistId))
        .where(notHiddenAsDuplicate(userId, songArtistTable.songId))
        .groupBy(artistTable.artistId)
        .orderBy(asc(artistTable.name));
}
