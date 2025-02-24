import { GenericDb } from "../GenericDb";
import { Tag } from "../models";
import { songTable, songTagTable, tagTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";

export async function updateTags(db: GenericDb, newTags: Tag[]): Promise<void> {
    const localTags = await db.select().from(tagTable);
    const tagsToRemove = localTags.filter(localTag => !newTags.some(newTag => newTag.tagId === localTag.tagId));

    await db.insert(tagTable).values(newTags).onConflictDoUpdate({
        target: tagTable.tagId,
        set: {
            name: sql`excluded.name`
        }
    });
    
    if (tagsToRemove) {
        for (const tagToRemove of tagsToRemove) {
            await db.delete(tagTable).where(eq(tagTable.tagId, tagToRemove.tagId));
        }
    }
}

export async function getTagsFromSong(db: GenericDb, songId: number): Promise<Tag[]> {
    return await db
        .selectDistinct({
            tagId: tagTable.tagId,
            name: tagTable.name,
        })
        .from(songTagTable)
        .where(eq(songTagTable.songId, songId))
        .innerJoin(tagTable, eq(tagTable.tagId, songTagTable.tagId));
}
