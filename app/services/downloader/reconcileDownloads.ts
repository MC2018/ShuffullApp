import DbQueries from "../db/queries";
import { GenericDb } from "../db/GenericDb";
import type { DesktopMediaStore } from "../desktopShell";
import { DownloadReconcile, reconcileDownloads } from "../../tools/downloadReconcile";
import { log } from "../../tools/log";

/** Lists the music folder. Given the file names of every local song, for a store that can only be asked one by one. */
export type ListSongFiles = (songFileNames: string[]) => Promise<Iterable<string>>;

type SongFileName = (song: { fileHash: string; fileExtension: string }) => string;

/**
 * Brings the downloaded_songs table in line with the music folder (see tools/downloadReconcile.ts). Shared by the
 * native and desktop Downloaders, which differ only in how they list the folder.
 *
 * The rows are read BEFORE the folder is listed. The Downloader moves a file into place and only then adds its row,
 * so in this order a song mid-download is never seen with a row but without its file, and never loses the row it is
 * about to get. If the folder can't be listed, `listFiles` throws and nothing is changed.
 */
export async function reconcileDownloadsWithDisk(db: GenericDb, listFiles: ListSongFiles, songFileName: SongFileName): Promise<DownloadReconcile> {
    const songs = (await DbQueries.getSongDownloadRows(db)).map(x => ({ songId: x.songId, fileName: songFileName(x), downloaded: x.downloaded }));
    const result = reconcileDownloads(songs, new Set(await listFiles(songs.map(x => x.fileName))));

    await DbQueries.addDownloadedSongs(db, result.record);
    await DbQueries.removeDownloadedSongs(db, result.forget);

    if (result.record.length || result.forget.length) {
        log.info("downloader", `matched downloads to disk: recorded ${result.record.length} song(s) found on disk, forgot ${result.forget.length} whose file is gone`);
    }
    return result;
}

/**
 * reconcileDownloadsWithDisk as a Downloader runs it: overlapping callers (start-up, a sync, the Downloads screen)
 * share one pass, and it never throws. A folder that can't be read just leaves the rows as they are.
 */
export function createDiskReconciler(db: GenericDb, listFiles: ListSongFiles, songFileName: SongFileName): () => Promise<void> {
    let running: Promise<void> | undefined;
    return () => {
        running ??= (async () => {
            try {
                await reconcileDownloadsWithDisk(db, listFiles, songFileName);
            } catch (e) {
                log.warn("downloader", "couldn't match downloads to disk", e);
            } finally {
                running = undefined;
            }
        })();
        return running;
    };
}

/**
 * The song files in the desktop store. One call where the shell can list; a shell built before `list` existed is
 * asked about each local song instead.
 */
export async function listStoredSongFiles(media: Pick<DesktopMediaStore, "list" | "exists">, songFileNames: string[]): Promise<string[]> {
    if (media.list) {
        return await media.list("music");
    }
    const stored: string[] = [];
    for (const fileName of songFileNames) {
        if (await media.exists("music", fileName)) {
            stored.push(fileName);
        }
    }
    return stored;
}
