import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { GenericDb } from "../db/GenericDb";
import { Song } from "../db/models";
import { localMediaUri, parseLocalMediaUri } from "../../tools/desktopMedia";
import { desktopShell, DesktopMediaStore, pageOrigin } from "../desktopShell";
import { albumArtFileName, DownloadQueueRunner, songFileName } from "./DownloadQueueRunner";
import { createDesktopDownloadAdapter } from "./desktopDownloadAdapter";
import { log } from "../../tools/log";

/**
 * Web build of the Downloader. Metro picks this over `Downloader.ts` for the web platform, which covers two very
 * different hosts:
 *
 * - **The Electron desktop app.** Its preload exposes `window.shuffull.media`, an offline store the main process
 *   keeps on disk (desktop/media.js). Here this is the same download loop as the phone (DownloadQueueRunner.ts) on
 *   the desktop adapter (desktopDownloadAdapter.ts), and stored files are served back on the page's own origin, so
 *   playback and album art pick them up through `fileExists` exactly as they do on native.
 * - **A plain browser.** No bridge, no filesystem. The runner gets no adapter: downloads report "unsupported", the
 *   queue methods are accepted and ignored so a stray tap is a no-op, and `fileExists` is always false so everything
 *   streams.
 *
 * The native Downloader can't be reused directly: it is built on `expo-file-system`, which has no web
 * implementation (it throws "documentDirectory is null" at module scope).
 */

/** The desktop shell's media store, or undefined in a plain browser (and during `expo export`'s prerender). */
function mediaBridge(): DesktopMediaStore | undefined {
    return desktopShell()?.media;
}

export class Downloader extends DownloadQueueRunner {
    private static instance: Downloader | undefined;

    public static shared(db: GenericDb): Downloader {
        if (Downloader.instance == undefined) {
            Downloader.instance = new Downloader(db);
        }
        return Downloader.instance;
    }

    /** reconcileWithDisk on the running Downloader, for a sync that just brought new songs. Nothing if none started. */
    public static async reconcileShared(): Promise<void> {
        await Downloader.instance?.reconcileWithDisk();
    }

    /** clearQueueAndSettle on the running Downloader. True if none started: then nothing is in flight. */
    public static async clearQueueAndSettleShared(timeoutMs: number): Promise<boolean> {
        return await Downloader.instance?.clearQueueAndSettle(timeoutMs) ?? true;
    }

    private constructor(db: GenericDb) {
        const media = mediaBridge();
        super({ db, adapter: media && createDesktopDownloadAdapter(media), storage: AsyncStorage });
        void this.start();
    }

    /** True when the URI is one of ours and the desktop store has the file. Always false in a plain browser. */
    public static async fileExists(uri: string) {
        const media = mediaBridge();
        const parsed = parseLocalMediaUri(uri);
        if (media == undefined || parsed == undefined) {
            return false;
        }
        try {
            return await media.exists(parsed.kind, parsed.fileName);
        } catch {
            return false;
        }
    }

    // Shared with the native build — pure string building, no filesystem involved.
    public static generateSongFileName(song: { fileHash: string; fileExtension: string }) {
        return songFileName(song);
    }

    public static generateAlbumArtFileName(song: Song) {
        return albumArtFileName(song);
    }

    /**
     * Where the desktop store serves this song from. In a plain browser there is no local URI; the empty string
     * keeps the signature intact while `fileExists` (always false there) decides, so nothing plays from it.
     */
    public static generateLocalSongUri(song: Song) {
        return mediaBridge() ? localMediaUri(pageOrigin(), "music", Downloader.generateSongFileName(song)) : "";
    }

    public static generateLocalAlbumArtUri(song: Song) {
        return mediaBridge() ? localMediaUri(pageOrigin(), "albumart", Downloader.generateAlbumArtFileName(song)) : "";
    }

    /** Removes a song's stored audio + album art. Best-effort and idempotent, like native; doesn't touch the DB. */
    public static async deleteLocalSongFiles(song: Song) {
        const media = mediaBridge();
        if (media == undefined) {
            return;
        }
        try {
            await media.remove("music", Downloader.generateSongFileName(song));
            await media.remove("albumart", Downloader.generateAlbumArtFileName(song));
        } catch (e) {
            log.warn("downloader", `Failed to delete local files for song ${song.songId}:`, e);
        }
    }

    public static async generateServerAlbumArtUrl(song: Song) {
        const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
        return `${hostAddress ?? ""}/albumart/${Downloader.generateAlbumArtFileName(song)}`;
    }

    /** The streaming URL used in place of a stored file. */
    public static async generateServerSongUrl(song: Song) {
        const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
        return `${hostAddress ?? ""}/music/${Downloader.generateSongFileName(song)}`;
    }
}
