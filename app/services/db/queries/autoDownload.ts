import { and, eq, inArray, sql } from "drizzle-orm";
import { GenericDb } from "../GenericDb";
import {
    autoDownloadPendingTable,
    autoDownloadSettingsTable,
    downloadedSongTable,
    downloadQueueTable,
    playlistSongTable,
    playlistTable,
    songTable,
    userSongTable,
} from "../schema";
import { DownloadPriority } from "../types";
import { withTransaction } from "../transaction";
import {
    AutoDownloadSettings,
    CandidatePlaylist,
    CandidateSong,
    DownloadSource,
    normalizeSettings,
    PendingDifference,
    ReconcilePlan,
} from "@/app/tools/autoDownloads";
import { chunkIds, chunkRows } from "./_chunk";
import { notHiddenAsDuplicate } from "./duplicateReport";
import { addToDownloadQueue } from "./downloadQueue";

// Auto-downloads (ShuffullApp#225). The rules live in tools/autoDownloads.ts; these read what they need and write
// back what they decide.

/** This device's rules for the user. No row means the defaults: tier off, nothing wanted. */
export async function getAutoDownloadSettings(db: GenericDb, userId: string): Promise<AutoDownloadSettings> {
    const rows = await db.select().from(autoDownloadSettingsTable).where(eq(autoDownloadSettingsTable.userId, userId)).limit(1);
    return normalizeSettings(rows[0]);
}

/** Changes some of the user's rules on this device, keeping the rest. Returns the rules as saved. */
export async function saveAutoDownloadSettings(db: GenericDb, userId: string, changes: Partial<AutoDownloadSettings>): Promise<AutoDownloadSettings> {
    return withTransaction(db, async (tx) => {
        const settings = normalizeSettings({ ...(await getAutoDownloadSettings(tx, userId)), ...changes });
        await tx.insert(autoDownloadSettingsTable).values({ userId, ...settings })
            .onConflictDoUpdate({ target: autoDownloadSettingsTable.userId, set: settings });
        return settings;
    });
}

/** The free-space floor for the account signed in on this device, or the default with none. */
export async function getAutoDownloadFloorBytes(db: GenericDb, userId: string | undefined): Promise<number> {
    return userId == undefined ? normalizeSettings(undefined).freeFloorBytes : (await getAutoDownloadSettings(db, userId)).freeFloorBytes;
}

/** Every song on this device, as the user sees it: like status, last play, and whether they hid it as a duplicate. */
export async function getAutoDownloadCandidates(db: GenericDb, userId: string): Promise<CandidateSong[]> {
    const rows = await db
        .select({
            songId: songTable.songId,
            exploratory: songTable.exploratory,
            likeStatus: userSongTable.likeStatus,
            lastPlayed: userSongTable.lastPlayed,
            visible: sql<number>`${notHiddenAsDuplicate(userId, songTable.songId)}`,
        })
        .from(songTable)
        .leftJoin(userSongTable, and(eq(userSongTable.songId, songTable.songId), eq(userSongTable.userId, userId)));

    return rows.map((x) => ({
        songId: x.songId,
        exploratory: x.exploratory,
        likeStatus: x.likeStatus ?? null,
        lastPlayedMs: x.lastPlayed == null ? null : x.lastPlayed.getTime(),
        hidden: !Number(x.visible),
    }));
}

/** The playlists on this device with their songs. Only the user's own count as mixes or Subscriptions (see wantedSongIds). */
export async function getAutoDownloadPlaylists(db: GenericDb, userId: string): Promise<CandidatePlaylist[]> {
    const playlists = await db.select().from(playlistTable);
    const links = await db.select({ playlistId: playlistSongTable.playlistId, songId: playlistSongTable.songId }).from(playlistSongTable);
    const songsByPlaylist = new Map<string, string[]>();
    for (const link of links) {
        const list = songsByPlaylist.get(link.playlistId) ?? [];
        list.push(link.songId);
        songsByPlaylist.set(link.playlistId, list);
    }
    return playlists.map((x) => ({
        playlistId: x.playlistId,
        name: x.name,
        // Mixes and Subscriptions are the user's own audition playlists; a shared one is never taken for either.
        isExploratory: x.isExploratory && x.userId === userId,
        songIds: songsByPlaylist.get(x.playlistId) ?? [],
    }));
}

/** What this device has: every downloaded and queued song, with who asked for it. */
export async function getDownloadSources(db: GenericDb): Promise<{ downloaded: Map<string, DownloadSource>; queued: Map<string, DownloadSource> }> {
    const downloadedRows = await db.select({ songId: downloadedSongTable.songId, source: downloadedSongTable.source }).from(downloadedSongTable);
    const queuedRows = await db.select({ songId: downloadQueueTable.songId, source: downloadQueueTable.source }).from(downloadQueueTable);
    const downloaded = new Map<string, DownloadSource>();
    for (const row of downloadedRows) {
        // A duplicate row (older builds could write one) counts as manual if either says so.
        if (downloaded.get(row.songId) !== "manual") {
            downloaded.set(row.songId, row.source);
        }
    }
    return { downloaded, queued: new Map(queuedRows.map((x) => [x.songId, x.source])) };
}

export async function getAutoDownloadPending(db: GenericDb): Promise<PendingDifference[]> {
    const rows = await db.select().from(autoDownloadPendingTable);
    return rows.map((x) => ({ songId: x.songId, action: x.action, firstSeenAt: x.firstSeenAt.getTime() }));
}

export interface RemovedDownload {
    songId: string;
    /** Null when the song row is gone from this device; its files can't be named then. */
    song: typeof songTable.$inferSelect | null;
}

/**
 * Writes one reconcile run's plan in a single transaction: the pending rows, the new auto queue rows, and the removal
 * of auto rows no longer wanted. The removal re-checks `source = 'auto'` in SQL, so a song the user took over by hand
 * since the plan was made is left alone. Returns the downloads it removed, whose files the caller deletes AFTER this
 * commits (no file I/O inside a transaction).
 */
export async function applyAutoDownloadPlan(db: GenericDb, plan: ReconcilePlan): Promise<RemovedDownload[]> {
    return withTransaction(db, async (tx) => {
        for (const idChunk of chunkIds(plan.deletePending)) {
            await tx.delete(autoDownloadPendingTable).where(inArray(autoDownloadPendingTable.songId, idChunk));
        }
        const pendingRows = plan.insertPending.map((x) => ({ songId: x.songId, action: x.action, firstSeenAt: new Date(x.firstSeenAt) }));
        for (const rowChunk of chunkRows(pendingRows)) {
            await tx.insert(autoDownloadPendingTable).values(rowChunk).onConflictDoUpdate({
                target: autoDownloadPendingTable.songId,
                set: { action: sql`excluded.action`, firstSeenAt: sql`excluded.first_seen_at` },
            });
        }

        await addToDownloadQueue(tx, plan.enqueue, DownloadPriority.Low, "auto");

        const removed: RemovedDownload[] = [];
        for (const idChunk of chunkIds(plan.remove)) {
            await tx.delete(downloadQueueTable)
                .where(and(inArray(downloadQueueTable.songId, idChunk), eq(downloadQueueTable.source, "auto")));
            const doomed = await tx
                .select({ songId: downloadedSongTable.songId, song: songTable })
                .from(downloadedSongTable)
                .leftJoin(songTable, eq(songTable.songId, downloadedSongTable.songId))
                .where(and(inArray(downloadedSongTable.songId, idChunk), eq(downloadedSongTable.source, "auto")));
            // Not if a duplicate manual row exists for the same song (see getDownloadSources).
            const manual = new Set((await tx.select({ songId: downloadedSongTable.songId }).from(downloadedSongTable)
                .where(and(inArray(downloadedSongTable.songId, idChunk), eq(downloadedSongTable.source, "manual")))).map((x) => x.songId));
            const ids = [...new Set(doomed.map((x) => x.songId))].filter((x) => !manual.has(x));
            if (ids.length) {
                await tx.delete(downloadedSongTable).where(inArray(downloadedSongTable.songId, ids));
            }
            const seen = new Set<string>();
            for (const row of doomed) {
                if (ids.includes(row.songId) && !seen.has(row.songId)) {
                    seen.add(row.songId);
                    removed.push({ songId: row.songId, song: row.song });
                }
            }
        }
        return removed;
    });
}

/** The file hashes still used by a download or a queued download, among the given ones. */
export async function fileHashesStillDownloaded(db: GenericDb, fileHashes: string[]): Promise<Set<string>> {
    const inUse = new Set<string>();
    for (const hashChunk of chunkIds(fileHashes)) {
        const downloaded = await db.select({ fileHash: songTable.fileHash }).from(downloadedSongTable)
            .innerJoin(songTable, eq(songTable.songId, downloadedSongTable.songId))
            .where(inArray(songTable.fileHash, hashChunk));
        const queued = await db.select({ fileHash: songTable.fileHash }).from(downloadQueueTable)
            .innerJoin(songTable, eq(songTable.songId, downloadQueueTable.songId))
            .where(inArray(songTable.fileHash, hashChunk));
        [...downloaded, ...queued].forEach((x) => inUse.add(x.fileHash));
    }
    return inUse;
}

export async function countAutoDownloadPending(db: GenericDb): Promise<{ add: number; remove: number }> {
    const rows = await db.select({ action: autoDownloadPendingTable.action, n: sql<number>`count(*)` })
        .from(autoDownloadPendingTable).groupBy(autoDownloadPendingTable.action);
    return {
        add: Number(rows.find((x) => x.action === "add")?.n ?? 0),
        remove: Number(rows.find((x) => x.action === "remove")?.n ?? 0),
    };
}
