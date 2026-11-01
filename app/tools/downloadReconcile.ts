/**
 * Squares the downloaded-songs table with the files actually in the music folder (ShuffullApp#56), so the Downloads
 * list shows what is on disk:
 *
 * - a song whose file is there but which has no row gets one (an earlier run moved the file, then died before
 *   recording it; or the local DB was rebuilt while the files stayed);
 * - a song with a row whose file is gone loses the row (the OS or the user cleared the folder).
 *
 * Only ever the rows. A file is never deleted here, and a file no local song names is left alone.
 * Pure so it can be tested; the Downloaders supply the songs and the folder listing.
 */

export interface SongFileState {
    songId: string;
    /** `Downloader.generateSongFileName(song)`: `<fileHash><fileExtension>`. */
    fileName: string;
    /** Whether the song has a downloaded_songs row. */
    downloaded: boolean;
}

export interface DownloadReconcile {
    /** Songs whose file is on disk but have no row. */
    record: string[];
    /** Songs with a row whose file is gone. */
    forget: string[];
}

export function reconcileDownloads(songs: readonly SongFileState[], filesOnDisk: ReadonlySet<string>): DownloadReconcile {
    const record: string[] = [];
    const forget: string[] = [];

    for (const song of songs) {
        const onDisk = filesOnDisk.has(song.fileName);
        if (onDisk && !song.downloaded) {
            record.push(song.songId);
        } else if (!onDisk && song.downloaded) {
            forget.push(song.songId);
        }
    }

    return { record, forget };
}
