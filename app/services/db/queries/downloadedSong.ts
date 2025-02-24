import { DownloadPriority } from "@/app/tools";
import { GenericDb } from "../GenericDb";
import { downloadedSongTable } from "../schema";
import { eq, gt, lt, ExtractTablesWithRelations, inArray, sql, isNotNull, and, desc, asc, or } from "drizzle-orm";
import { DownloadQueue } from "../models";

export async function addDownloadedSong(db: GenericDb, songId: number): Promise<void> {
    await db.insert(downloadedSongTable).values({
        songId: songId
    });
}
