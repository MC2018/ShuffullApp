import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { GenericDb } from "../db/GenericDb";
import DbQueries from "../db/queries";
import { Song } from "../db/models";
import { DownloadPriority } from "../db/types";
import { useDownloadStatus } from "./downloadStatus";
import { derivePhase, retryDelayMs } from "../../tools/downloadStatus";
import { localMediaUri, parseLocalMediaUri } from "../../tools/desktopMedia";
import { desktopShell, DesktopMediaStore } from "../desktopShell";
import { sleep } from "../../tools/utils";

/**
 * Web build of the Downloader. Metro picks this over `Downloader.ts` for the web platform, which covers two very
 * different hosts:
 *
 * - **The Electron desktop app.** Its preload exposes `window.shuffull.media`, an offline store the main process
 *   keeps on disk (desktop/media.js). Here this is a real Downloader: it drains the same DB queue as the phone,
 *   publishes the same status, and stored files are served back on the page's own origin, so playback and album
 *   art pick them up through `fileExists` exactly as they do on native.
 * - **A plain browser.** No bridge, no filesystem. Downloads report "unsupported", the queue methods are accepted
 *   and ignored so a stray tap is a no-op, and `fileExists` is always false so everything streams.
 *
 * The native Downloader can't be reused directly: it is built on `expo-file-system`, which has no web
 * implementation (it throws "documentDirectory is null" at module scope). What differs from it here:
 *
 * - **Network gate: online is enough.** The phone's Wi-Fi allowlist protects a data plan; a desktop has none, and
 *   the web network API can't tell Wi-Fi from Ethernet, so the allowlist would wait for Wi-Fi forever. The status
 *   says so (`wifiOnly: false`) and the Downloads screen words its note to match.
 * - **No foreground service.** The Electron window keeps the renderer alive; there is nothing to hold.
 * - **Album art is best-effort.** A song with no art on the server still counts as downloaded rather than failing
 *   forever. The player falls back to the server URL for art it can't find locally.
 */

/** The desktop shell's media store, or undefined in a plain browser (and during `expo export`'s prerender). */
function mediaBridge(): DesktopMediaStore | undefined {
    return desktopShell()?.media;
}

function pageOrigin(): string {
    return typeof window === "undefined" ? "" : window.location.origin;
}

function isOnline(): boolean {
    return typeof navigator === "undefined" || navigator.onLine !== false;
}

// Safety net only, as on native: enqueue, resume and coming back online all kick the loop directly.
const WATCHDOG_MS = 10000;

type Attempt = "downloaded" | "skipped" | "blocked" | "failed";

export class Downloader {
    private static instance: Downloader | undefined;

    public static shared(db: GenericDb): Downloader {
        if (Downloader.instance == undefined) {
            Downloader.instance = new Downloader(db);
        }
        return Downloader.instance;
    }

    private draining = false;
    downloading = false;
    // Starts true so nothing can start before the persisted value is read; the constructor flips it.
    paused = true;
    db: GenericDb;
    private readonly media: DesktopMediaStore | undefined;
    private songInFlight: { songId: string; fileName: string; name: string } | undefined;
    private consecutiveFailures = 0;

    private constructor(db: GenericDb) {
        this.db = db;
        this.media = mediaBridge();

        if (this.media == undefined) {
            // Plain browser: say honestly that there is nothing to manage here.
            useDownloadStatus.getState().setStatus({ phase: "unsupported", queuedCount: 0, current: undefined });
            return;
        }

        useDownloadStatus.getState().setStatus({ wifiOnly: false });

        this.media.onProgress(({ kind, fileName, received, total }) => {
            if (kind === "music" && total > 0 && this.songInFlight?.fileName === fileName) {
                this.publishProgress(this.songInFlight.songId, received / total);
            }
        });

        setInterval(() => {
            this.kick();
            void this.publishStatus();
        }, WATCHDOG_MS);

        // Pause is a user decision and survives restarts - same key as native.
        (async () => {
            this.paused = (await AsyncStorage.getItem(STORAGE_KEYS.DOWNLOADS_PAUSED)) === "1";
            await this.publishStatus();
            this.kick();
        })();

        // Show "offline" the moment the connection drops, and pick the queue back up the moment it returns.
        window.addEventListener("online", () => {
            void this.publishStatus();
            this.kick();
        });
        window.addEventListener("offline", () => void this.publishStatus());
    }

    /** Stops starting NEW downloads. A song already in flight is allowed to finish. */
    public async pause() {
        if (this.media == undefined) {
            return;
        }
        this.paused = true;
        await AsyncStorage.setItem(STORAGE_KEYS.DOWNLOADS_PAUSED, "1");
        await this.publishStatus();
    }

    public async resume() {
        if (this.media == undefined) {
            return;
        }
        this.paused = false;
        await AsyncStorage.setItem(STORAGE_KEYS.DOWNLOADS_PAUSED, "0");
        await this.publishStatus();
        this.kick();
    }

    public async removeFromQueue(songId: string) {
        if (this.media == undefined) {
            return;
        }
        await DbQueries.removeFromDownloadQueue(this.db, songId);
        await this.publishStatus();
    }

    public async clearQueue() {
        if (this.media == undefined) {
            return;
        }
        await DbQueries.removeAllFromDownloadQueue(this.db);
        await this.publishStatus();
    }

    public async addSongToDownloadQueue(songId: string, priority: DownloadPriority) {
        if (this.media == undefined) {
            return;
        }
        await DbQueries.addToDownloadQueue(this.db, [songId], priority);
        await this.publishStatus();
        this.kick();
    }

    /** Returns what happened so the button can say so: how many were queued vs. already on disk. */
    public async addPlaylistToDownloadQueue(playlistId: string, priority: DownloadPriority): Promise<{ queued: number; alreadyDownloaded: number }> {
        if (this.media == undefined) {
            return { queued: 0, alreadyDownloaded: 0 };
        }
        const songs = await DbQueries.getSongsByPlaylist(this.db, playlistId);
        const toQueue: string[] = [];
        let alreadyDownloaded = 0;

        for (const song of songs) {
            if (await this.media.exists("music", Downloader.generateSongFileName(song))) {
                alreadyDownloaded++;
            } else {
                toQueue.push(song.songId);
            }
        }

        await DbQueries.addToDownloadQueue(this.db, toQueue, priority);
        await this.publishStatus();
        this.kick();
        return { queued: toQueue.length, alreadyDownloaded };
    }

    /** Starts the drain loop if it isn't already running. Safe to call from anywhere, any number of times. */
    public kick() {
        if (this.media == undefined || this.draining) {
            return;
        }
        void this.drain();
    }

    private async drain() {
        this.draining = true;
        try {
            while (!this.paused) {
                const attempt = await this.downloadNext();

                if (attempt === "blocked") {
                    break;
                }

                if (attempt === "failed") {
                    this.consecutiveFailures++;
                    await sleep(retryDelayMs(this.consecutiveFailures));
                } else {
                    this.consecutiveFailures = 0;
                }
            }
        } finally {
            this.draining = false;
            await this.publishStatus();
        }
    }

    private async publishStatus() {
        try {
            const queuedCount = await DbQueries.countDownloadQueue(this.db);
            const phase = derivePhase({
                paused: this.paused,
                downloading: this.downloading,
                queuedCount,
                network: { isInternetReachable: isOnline(), type: undefined },
                wifiOnly: false,
            });
            const current = useDownloadStatus.getState().status.current;
            useDownloadStatus.getState().setStatus({
                phase,
                queuedCount,
                current: this.songInFlight ? (current?.songId === this.songInFlight.songId ? current : { songId: this.songInFlight.songId, progress: 0 }) : undefined,
            });
        } catch (e) {
            console.warn("[downloader] failed to publish status", e);
        }
    }

    private publishProgress(songId: string, progress: number) {
        const current = useDownloadStatus.getState().status.current;
        if (current?.songId === songId && Math.round(current.progress * 100) === Math.round(progress * 100)) {
            return;
        }
        useDownloadStatus.getState().setStatus({ current: { songId, progress } });
    }

    /** One attempt at the head of the queue. Only ever called by the drain loop. */
    private async downloadNext(): Promise<Attempt> {
        const media = this.media;
        if (this.paused || media == undefined) {
            return "blocked";
        }

        try {
            const nextDownload = await DbQueries.getFromDownloadQueue(this.db);

            if (!nextDownload) {
                return "blocked";
            }

            const song = await DbQueries.getSong(this.db, nextDownload.songId);

            if (!song) {
                await DbQueries.removeFromDownloadQueue(this.db, nextDownload.songId);
                return "skipped";
            }

            if (!isOnline()) {
                return "blocked";
            }

            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

            if (hostAddress == null) {
                return "blocked";
            }

            const songFileName = Downloader.generateSongFileName(song);

            if (await media.exists("music", songFileName)) {
                await DbQueries.removeFromDownloadQueue(this.db, song.songId);
                return "skipped";
            }

            this.downloading = true;
            this.songInFlight = { songId: song.songId, fileName: songFileName, name: song.name };
            this.publishProgress(song.songId, 0);
            await this.publishStatus();

            // Main verifies the hash before the file is moved into place, so a failure leaves nothing behind.
            const songResult = await media.download(hostAddress, "music", songFileName);

            if (!songResult.ok) {
                console.warn(`[downloader] ${song.name}: ${songResult.error}`);
                return "failed";
            }

            const artResult = await media.download(hostAddress, "albumart", Downloader.generateAlbumArtFileName(song));

            if (!artResult.ok) {
                console.warn(`[downloader] no album art saved for ${song.name}: ${artResult.error}`);
            }

            await DbQueries.addDownloadedSong(this.db, song.songId);
            await DbQueries.removeFromDownloadQueue(this.db, song.songId);
            useDownloadStatus.getState().setStatus({ completedCount: useDownloadStatus.getState().status.completedCount + 1 });
            return "downloaded";
        } catch (e) {
            console.error("[downloader] attempt failed", e);
            return "failed";
        } finally {
            this.downloading = false;
            this.songInFlight = undefined;
            await this.publishStatus();
        }
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
        return `${song.fileHash}${song.fileExtension}`;
    }

    public static generateAlbumArtFileName(song: Song) {
        return `${song.fileHash}.jpg`;
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
            console.warn(`Failed to delete local files for song ${song.songId}:`, e);
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
