import { GenericDb } from "../db/GenericDb";
import {
    applyAutoDownloadPlan,
    fileHashesStillDownloaded,
    getAutoDownloadCandidates,
    getAutoDownloadPending,
    getAutoDownloadPlaylists,
    getAutoDownloadSettings,
    getDownloadSources,
    RemovedDownload,
} from "../db/queries/autoDownload";
import { Song } from "../db/models";
import { diffAutoDownloads, fileHashesToDelete, planReconcile, wantedSongIds, wantsAnything } from "../../tools/autoDownloads";

export interface ReconcileResult {
    /** Songs queued as auto downloads this run. */
    enqueued: number;
    /** Songs whose auto download or auto queue row was due to go this run. */
    removed: number;
    /** Differences still waiting out the delay after this run. */
    waiting: number;
}

/**
 * One run of the auto-download reconciler (ShuffullApp#225), free of platform imports so it can be tested. The runner
 * (autoDownloader.ts) supplies the clock, the songs the player has lined up, and how to delete a song's files.
 *
 * Read the rules, the songs and what this device has; work out the difference; let the pending table hold each
 * difference for the delay; write what is due in one transaction; then, after it commits, delete the files of the
 * removed downloads. A file another remaining download (or queued one) shares is left alone. A crash between the
 * commit and the file deletes leaves an orphaned file, never a download row pointing at a missing file.
 */
export async function reconcileAutoDownloads(input: {
    db: GenericDb;
    userId: string;
    nowMs: number;
    protectedIds: ReadonlySet<string>;
    deleteFiles: (song: Song) => Promise<void>;
    delayMs?: number;
}): Promise<ReconcileResult> {
    const { db, userId, nowMs } = input;
    const settings = await getAutoDownloadSettings(db, userId);
    // Rules that want nothing (Off, the default) skip reading the library: the run only winds down earlier auto downloads.
    const wanted = wantsAnything(settings)
        ? wantedSongIds({
            settings,
            songs: await getAutoDownloadCandidates(db, userId),
            playlists: await getAutoDownloadPlaylists(db, userId),
            nowMs,
        })
        : [];
    const { downloaded, queued } = await getDownloadSources(db);
    const differences = diffAutoDownloads({ wanted, downloaded, queued, protectedIds: input.protectedIds });
    const pending = await getAutoDownloadPending(db);
    const plan = planReconcile({ differences, pending, nowMs, delayMs: input.delayMs });

    const removed = await applyAutoDownloadPlan(db, plan);
    await deleteRemovedFiles(db, removed, input.deleteFiles);

    // Every difference is either acted on now or has a pending row waiting out the delay.
    const waiting = differences.length - plan.enqueue.length - plan.remove.length;
    return { enqueued: plan.enqueue.length, removed: plan.remove.length, waiting };
}

async function deleteRemovedFiles(db: GenericDb, removed: RemovedDownload[], deleteFiles: (song: Song) => Promise<void>) {
    const songs = removed.flatMap((x) => (x.song ? [x.song] : []));
    if (!songs.length) {
        return;
    }
    const kept = await fileHashesStillDownloaded(db, songs.map((x) => x.fileHash));
    const doomed = fileHashesToDelete({ removing: songs, keptFileHashes: kept });
    const done = new Set<string>();
    for (const song of songs) {
        if (doomed.has(song.fileHash) && !done.has(song.fileHash)) {
            done.add(song.fileHash);
            await deleteFiles(song);
        }
    }
}
