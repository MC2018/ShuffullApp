import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { GenericDb } from "../db/GenericDb";
import { Song } from "../db/models";
import { DownloadPriority } from "../db/types";

/**
 * Web/desktop build of the Downloader. Metro picks this over `Downloader.ts` for the web platform.
 *
 * The native one is built on `expo-file-system`, which has no web implementation — it throws
 * "documentDirectory is null" at module scope, killing the app during bundle evaluation. There is also no
 * meaningful equivalent to answer: a browser has no per-app filesystem to cache audio into, so on web the
 * player streams from the server rather than playing local files.
 *
 * Offline caching is therefore NOT supported here yet. The queue methods are accepted and ignored rather
 * than throwing, so a stray "download" tap is a no-op instead of a crash — but nothing is stored, and
 * `fileExists` always answers false, which makes every caller fall through to the server URL. That is the
 * correct behaviour for a streaming client and the honest behaviour for one that cannot cache.
 *
 * A real desktop implementation is very achievable later: Electron has Node in the main process, so audio
 * could be cached to a genuine directory over IPC and this file swapped for one that uses it. That is the
 * natural follow-up once playback itself is proven.
 */
export class Downloader {
    downloading = false;
    paused = true;
    db: GenericDb;

    constructor(db: GenericDb) {
        this.db = db;
    }

    public dispose() { }

    /** No local store to queue into — accepted and ignored so the UI stays usable. */
    public async addSongToDownloadQueue(_songId: string, _priority: DownloadPriority) { }

    public async addPlaylistToDownloadQueue(_playlistId: string, _priority: DownloadPriority) { }

    public async downloadNext() { }

    /** Always false: nothing is cached locally, so callers correctly fall through to the server URL. */
    public static async fileExists(_uri: string) {
        return false;
    }

    // Shared with the native build — pure string building, no filesystem involved.
    public static generateSongFileName(song: { fileHash: string; fileExtension: string }) {
        return `${song.fileHash}${song.fileExtension}`;
    }

    public static generateAlbumArtFileName(song: Song) {
        return `${song.fileHash}.jpg`;
    }

    /**
     * There is no local URI on web. Returning the empty string keeps the signature intact while guaranteeing
     * `fileExists` (always false) is what actually decides, so no caller ever tries to play from here.
     */
    public static generateLocalSongUri(_song: Song) {
        return "";
    }

    public static generateLocalAlbumArtUri(_song: Song) {
        return "";
    }

    /** Nothing cached, nothing to delete. Idempotent by construction. */
    public static async deleteLocalSongFiles(_song: Song) { }

    public static async generateServerAlbumArtUrl(song: Song) {
        const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
        return `${hostAddress ?? ""}/albumart/${Downloader.generateAlbumArtFileName(song)}`;
    }

    /** The streaming URL the web player uses in place of a cached file. */
    public static async generateServerSongUrl(song: Song) {
        const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
        return `${hostAddress ?? ""}/music/${Downloader.generateSongFileName(song)}`;
    }
}
