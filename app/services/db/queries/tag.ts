import { GenericDb } from "../GenericDb";
import { Tag } from "../models";
import { songTable, songTagTable, tagTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { chunkRows } from "./_chunk";

export async function updateTags(db: GenericDb, newTags: Tag[]): Promise<void> {
    const localTags = await db.select().from(tagTable);
    const tagsToRemove = localTags.filter(localTag => !newTags.some(newTag => newTag.tagId === localTag.tagId));

    for (const rowChunk of chunkRows(newTags)) {
        await db.insert(tagTable).values(rowChunk).onConflictDoUpdate({
            target: tagTable.tagId,
            set: {
                name: sql`excluded.name`
            }
        });
    }

    if (tagsToRemove) {
        for (const tagToRemove of tagsToRemove) {
            await db.delete(tagTable).where(eq(tagTable.tagId, tagToRemove.tagId));
        }
    }
}

export async function getTagsFromSong(db: GenericDb, songId: string): Promise<Tag[]> {
    return await db
        .selectDistinct({
            tagId: tagTable.tagId,
            name: tagTable.name,
            type: tagTable.type,
        })
        .from(songTagTable)
        .where(eq(songTagTable.songId, songId))
        .innerJoin(tagTable, eq(tagTable.tagId, songTagTable.tagId));
}

export async function getTags(db: GenericDb): Promise<Tag[]> {
    return await db.select().from(tagTable);
}
