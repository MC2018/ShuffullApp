import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import * as FileSystem from "expo-file-system/legacy";
import { GenericDb } from "../db/GenericDb";
import path from "path-browserify";
import { Song } from "../db/models";
import { albumArtFileName, DownloadQueueRunner, songFileName } from "./DownloadQueueRunner";
import { albumArtFolder, createNativeDownloadAdapter, fileExists, musicFolder } from "./nativeDownloadAdapter";
import { log } from "../../tools/log";

/**
 * The native Downloader: the shared download loop (DownloadQueueRunner.ts) on the native adapter
 * (nativeDownloadAdapter.ts: expo-file-system, the Wi-Fi allowlist, the foreground service), plus the file
 * helpers the player and screens use. Metro picks Downloader.web.ts on web.
 *
 * A PROCESS-WIDE SINGLETON (`Downloader.shared`), deliberately not owned by a React component: on Android,
 * swiping the app away destroys the activity and unmounts the whole tree while the foreground service keeps the
 * process alive, so a loop that lived in a provider's effect was disposed on unmount and downloads silently
 * stopped, under a notification still claiming the app was running in the background.
 */
export class Downloader extends DownloadQueueRunner {
    private static instance: Downloader | undefined;

    /** reconcileWithDisk on the running Downloader, for a sync that just brought new songs. Nothing if none started. */
    public static async reconcileShared(): Promise<void> {
        await Downloader.instance?.reconcileWithDisk();
    }

    /** clearQueueAndSettle on the running Downloader. True if none started: then nothing is in flight. */
    public static async clearQueueAndSettleShared(timeoutMs: number): Promise<boolean> {
        return await Downloader.instance?.clearQueueAndSettle(timeoutMs) ?? true;
    }

    public static shared(db: GenericDb): Downloader {
        if (Downloader.instance == undefined) {
            Downloader.instance = new Downloader(db);
        }
        return Downloader.instance;
    }

    private constructor(db: GenericDb) {
        super({ db, adapter: createNativeDownloadAdapter(), storage: AsyncStorage });
        void this.start();
    }

    public static fileExists(uri: string) {
        return fileExists(uri);
    }

    public static generateSongFileName(song: { fileHash: string, fileExtension: string }) {
        return songFileName(song);
    }

    public static generateAlbumArtFileName(song: Song) {
        return albumArtFileName(song);
    }

    public static generateLocalSongUri(song: Song) {
        return path.join(musicFolder, Downloader.generateSongFileName(song));
    }

    // Removes a song's local audio + album-art files (keyed by fileHash). Best-effort and idempotent — pass the
    // OLD song record after its server fileHash changed so the now-orphaned files are cleaned up; missing files
    // are a no-op. Does not touch the DB (the caller clears the downloaded flag).
    public static async deleteLocalSongFiles(song: Song) {
        try {
            await FileSystem.deleteAsync(Downloader.generateLocalSongUri(song), { idempotent: true });
            await FileSystem.deleteAsync(Downloader.generateLocalAlbumArtUri(song), { idempotent: true });
        } catch (e) {
            log.warn("downloader", `Failed to delete local files for replaced song ${song.songId}:`, e);
        }
    }

    public static generateLocalAlbumArtUri(song: Song) {
        return path.join(albumArtFolder, Downloader.generateAlbumArtFileName(song));
    }

    public static async generateServerAlbumArtUrl(song: Song) {
        const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

        if (hostAddress == null) {
            throw new Error("Host address is null");
        }

        return path.join(hostAddress, "albumart", `${song.fileHash}.jpg`);
    }

    /** The song's album art as an image source: the downloaded copy if there is one, else the server's. */
    public static async resolveAlbumArt(song: Song): Promise<{ uri: string }> {
        const localUri = Downloader.generateLocalAlbumArtUri(song);
        if (await Downloader.fileExists(localUri)) {
            return { uri: localUri };
        }
        return { uri: await Downloader.generateServerAlbumArtUrl(song) };
    }
}
