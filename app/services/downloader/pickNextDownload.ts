import { GenericDb } from "../db/GenericDb";
import { DownloadQueue } from "../db/models";
import { getFromDownloadQueue } from "../db/queries/downloadQueue";
import { getActiveLocalSessionData } from "../db/queries/localSessionData";
import { getAutoDownloadFloorBytes } from "../db/queries/autoDownload";
import { autoDownloadFits, getSongSizeSource } from "../../tools/autoDownloads";

/**
 * Which queue row the Downloader takes next, applying the free-space floor (ShuffullApp#225). Shared by the native and
 * desktop Downloaders, and free of platform imports so it can be tested.
 *
 * A hand-picked (`manual`) row always goes: the user asked for that song. An auto row goes only if it leaves at least
 * the floor free, by the size estimate. When the head is an auto row that doesn't fit, a manual row further back (one
 * queued at Low priority) still gets its turn. `lowSpace` is true when the floor is all that stops the queue.
 *
 * `freeBytes` reads this device's free space. A failed or unknown read stops auto downloads (fails closed).
 */
export async function pickNextDownload(
    db: GenericDb,
    freeBytes: () => Promise<number | undefined>,
): Promise<{ row: DownloadQueue | undefined; lowSpace: boolean }> {
    const head = await getFromDownloadQueue(db);
    if (head == undefined || head.source !== "auto") {
        return { row: head, lowSpace: false };
    }

    const session = await getActiveLocalSessionData(db);
    const floorBytes = await getAutoDownloadFloorBytes(db, session?.userId);
    let free: number | undefined;
    try {
        free = await freeBytes();
    } catch (e) {
        console.warn("[downloader] couldn't read free space; automatic downloads wait", e);
    }
    if (autoDownloadFits({ freeBytes: free, songBytes: getSongSizeSource().bytesFor(head.songId), floorBytes })) {
        return { row: head, lowSpace: false };
    }

    const manual = await getFromDownloadQueue(db, "manual");
    return { row: manual, lowSpace: manual == undefined };
}
