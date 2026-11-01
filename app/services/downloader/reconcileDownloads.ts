import DbQueries from "../db/queries";
import { GenericDb } from "../db/GenericDb";
import { DownloadReconcile, reconcileDownloads } from "../../tools/downloadReconcile";

/**
 * Brings the downloaded_songs table in line with the music folder (see tools/downloadReconcile.ts). Shared by the
 * native and desktop Downloaders, which differ only in how they list the folder.
 *
 * The rows are read BEFORE the folder is listed. The Downloader moves a file into place and only then adds its row,
 * so in this order a song mid-download is never seen with a row but without its file, and never loses the row it is
 * about to get. If the folder can't be listed, `listFiles` throws and nothing is changed.
 */
export async function reconcileDownloadsWithDisk(
    db: GenericDb,
    listFiles: () => Promise<Iterable<string>>,
    songFileName: (song: { fileHash: string; fileExtension: string }) => string,
): Promise<DownloadReconcile> {
    const songs = (await DbQueries.getSongFileStates(db)).map(x => ({ songId: x.songId, fileName: songFileName(x), downloaded: x.downloaded }));
    const result = reconcileDownloads(songs, new Set(await listFiles()));

    await DbQueries.addDownloadedSongs(db, result.record);
    await DbQueries.removeDownloadedSongs(db, result.forget);

    if (result.record.length || result.forget.length) {
        console.log(`[downloader] matched downloads to disk: recorded ${result.record.length} song(s) found on disk, forgot ${result.forget.length} whose file is gone`);
    }
    return result;
}
