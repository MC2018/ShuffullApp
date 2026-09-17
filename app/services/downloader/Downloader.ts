import DbQueries from "../db/queries";
import * as FileSystem from "expo-file-system/legacy";
import { sleep, verifyFileIntegrity } from "../../tools/utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { addNetworkStateListener, getNetworkStateAsync, NetworkState } from "expo-network";
import { AppState } from "react-native";
import { GenericDb } from "../db/GenericDb";
import path from "path-browserify";
import { Song } from "../db/models";
import { DownloadPriority } from "../db/types";
import { useDownloadStatus } from "./downloadStatus";
import { derivePhase, describeDownloadNotification, isDownloadNetwork, retryDelayMs, shouldHoldForegroundService } from "../../tools/downloadStatus";
import { foregroundService } from "../background/foregroundService";
import { ensureNotificationPermission } from "../background/notificationPermission";

if (FileSystem.documentDirectory == null) {
    throw new Error("documentDirectory is null");
}

const tempFolder = path.join(FileSystem.documentDirectory, "temp");
const musicFolder = path.join(FileSystem.documentDirectory, "music");
const albumArtFolder = path.join(FileSystem.documentDirectory, "albumart");

// Safety net only. Every event that can create work (enqueue, resume, network change, app foregrounded)
// kicks the loop directly; this just catches anything that slipped through.
const WATCHDOG_MS = 10000;

/**
 * Outcome of one attempt at the head of the queue, which is what decides whether the loop keeps going:
 *   downloaded – a song landed; go straight to the next one
 *   skipped    – the row was dropped without work (song gone, already on disk); go on
 *   blocked    – nothing to do or not allowed to (empty, paused, no Wi-Fi, no host); stop and wait for an event
 *   failed     – the attempt errored; the row stays and the next try waits out a backoff
 */
type Attempt = "downloaded" | "skipped" | "blocked" | "failed";

/**
 * Drains the download queue. A PROCESS-WIDE SINGLETON (`Downloader.shared`), deliberately not owned by a
 * React component: on Android, swiping the app away destroys the activity and unmounts the whole tree
 * while the foreground service keeps the process alive — so a loop that lived in a provider's effect was
 * disposed on unmount and downloads silently stopped, under a notification still claiming the app was
 * running in the background. The instance now lives as long as the JS context does.
 *
 * Background execution: while there is queued work the Downloader holds the shared foreground service
 * (see background/foregroundService.ts), which is what keeps JS timers and the process alive after Home
 * or swipe-away, and publishes "Downloading N songs · title · 42%" to the notification shade. The hold is
 * released when the queue drains or the user pauses.
 */
export class Downloader {
    private static instance: Downloader | undefined;

    public static shared(db: GenericDb): Downloader {
        if (Downloader.instance == undefined) {
            Downloader.instance = new Downloader(db);
        }
        return Downloader.instance;
    }

    // True while the drain loop is running (between songs included), so a kick cannot start a second loop.
    private draining = false;
    // True only while a file is in flight; drives the "downloading" phase and the pause-with-in-flight hold.
    downloading = false;
    // Starts true so nothing can start before the persisted value is read; the constructor flips it.
    paused = true;
    db: GenericDb;
    // Last network state seen, from the listener (instant) or the polled read (each attempt). Only used
    // to publish the phase - the download itself always re-reads before starting.
    private network: NetworkState | undefined;
    private songInFlight: { songId: string; name: string } | undefined;
    private consecutiveFailures = 0;

    private constructor(db: GenericDb) {
        this.db = db;

        setInterval(() => {
            this.kick();
            // Even when nothing runs, keep the published phase honest (queue count, network).
            void this.publishStatus();
        }, WATCHDOG_MS);

        // Pause is a user decision, so it survives restarts (see CLAUDE.md "durability before enrichment"
        // - same principle at a smaller scale: the choice lives in storage, not in whatever the loop last did).
        // Reading it also (re)acquires the foreground hold if the last run was killed with work still queued.
        (async () => {
            this.paused = (await AsyncStorage.getItem(STORAGE_KEYS.DOWNLOADS_PAUSED)) === "1";
            await this.publishStatus();
            this.kick();
        })();

        // Surface "waiting for Wi-Fi" the moment the network changes rather than on the next tick — and
        // restart the loop when Wi-Fi comes back, which is the whole point of holding the service while waiting.
        addNetworkStateListener((state) => {
            this.network = state;
            void this.publishStatus();
            this.kick();
        });

        // Coming back to the app is the one moment a stopped service can be restarted (Android 12+ refuses
        // starts from the background), so make sure the loop is running if there is work.
        AppState.addEventListener("change", (state) => {
            if (state === "active") {
                this.kick();
            }
        });

        // Ensure directories exist
        (async () => {
            await FileSystem.makeDirectoryAsync(tempFolder, { intermediates: true });
            await FileSystem.makeDirectoryAsync(musicFolder, { intermediates: true });
            await FileSystem.makeDirectoryAsync(albumArtFolder, { intermediates: true });
        })();
    }

    /** Stops starting NEW downloads. A song already in flight is allowed to finish (they are single files). */
    public async pause() {
        this.paused = true;
        await AsyncStorage.setItem(STORAGE_KEYS.DOWNLOADS_PAUSED, "1");
        await this.publishStatus();
    }

    public async resume() {
        this.paused = false;
        await AsyncStorage.setItem(STORAGE_KEYS.DOWNLOADS_PAUSED, "0");
        // User actions are where the notification prompt makes sense (see notificationPermission.ts).
        await ensureNotificationPermission();
        await this.publishStatus();
        // Don't make the user wait out the timer to see it start.
        this.kick();
    }

    public async removeFromQueue(songId: string) {
        await DbQueries.removeFromDownloadQueue(this.db, songId);
        await this.publishStatus();
    }

    public async clearQueue() {
        await DbQueries.removeAllFromDownloadQueue(this.db);
        await this.publishStatus();
    }

    /** Starts the drain loop if it isn't already running. Safe to call from anywhere, any number of times. */
    public kick() {
        if (this.draining) {
            return;
        }
        void this.drain();
    }

    /**
     * Runs songs back-to-back until there is nothing to do. One loop at a time (`draining`); every path
     * out goes through publishStatus so the store and the notification reflect why it stopped.
     */
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

    /**
     * Recomputes the observable status from the queue, the loop's own flags and the last network state,
     * then mirrors it to the notification. Cheap (one COUNT), and the only writer of the store apart from
     * the in-flight progress callback.
     */
    private async publishStatus() {
        try {
            const queuedCount = await DbQueries.countDownloadQueue(this.db);
            if (this.network == undefined) {
                this.network = await getNetworkStateAsync();
            }
            const phase = derivePhase({
                paused: this.paused,
                downloading: this.downloading,
                queuedCount,
                network: { isInternetReachable: this.network.isInternetReachable === true, type: this.network.type },
            });
            const current = useDownloadStatus.getState().status.current;
            useDownloadStatus.getState().setStatus({
                phase,
                queuedCount,
                // Keep the progress the callback wrote; only clear it once nothing is in flight.
                current: this.songInFlight ? (current?.songId === this.songInFlight.songId ? current : { songId: this.songInFlight.songId, progress: 0 }) : undefined,
            });
            this.syncForegroundHold(queuedCount);
        } catch (e) {
            console.warn("[downloader] failed to publish status", e);
        }
    }

    private syncForegroundHold(queuedCount: number) {
        if (!shouldHoldForegroundService({ paused: this.paused, downloading: this.downloading, queuedCount })) {
            foregroundService.release("downloads");
            return;
        }
        foregroundService.hold("downloads", describeDownloadNotification(useDownloadStatus.getState().status, this.songInFlight?.name));
    }

    private publishProgress(songId: string, progress: number) {
        const current = useDownloadStatus.getState().status.current;
        // Throttle to whole-percent changes so a large file doesn't re-render the screen (or re-post the
        // notification) hundreds of times.
        if (current?.songId === songId && Math.round(current.progress * 100) === Math.round(progress * 100)) {
            return;
        }
        useDownloadStatus.getState().setStatus({ current: { songId, progress } });
        if (foregroundService.isHeld("downloads")) {
            foregroundService.hold("downloads", describeDownloadNotification(useDownloadStatus.getState().status, this.songInFlight?.name));
        }
    }

    public async addSongToDownloadQueue(songId: string, priority: DownloadPriority) {
        await DbQueries.addToDownloadQueue(this.db, [songId], priority);
        await ensureNotificationPermission();
        await this.publishStatus();
        this.kick();
    }

    // TODO: this could be optimized to prevent spam-presses
    /** Returns what happened so the button can say so: how many were queued vs. already on disk. */
    async addPlaylistToDownloadQueue(playlistId: string, priority: DownloadPriority): Promise<{ queued: number; alreadyDownloaded: number }> {
        let songs = await DbQueries.getSongsByPlaylist(this.db, playlistId);
        const existingSongs: string[] = [];

        for (let i = 0; i < songs.length; i++) {
            const localSongUri = Downloader.generateLocalSongUri(songs[i]);

            if (await Downloader.fileExists(localSongUri)) {
                existingSongs.push(songs[i].songId);
            }
        }

        songs = songs.filter(x => !existingSongs.includes(x.songId));
        await DbQueries.addToDownloadQueue(this.db, songs.map(x => x.songId), priority);
        if (songs.length > 0) {
            await ensureNotificationPermission();
        }
        await this.publishStatus();
        this.kick();
        return { queued: songs.length, alreadyDownloaded: existingSongs.length };
    }

    public static async fileExists(uri: string) {
        const fileInfo = await FileSystem.getInfoAsync(uri);
        return fileInfo.exists;
    }

    /** One attempt at the head of the queue. Only ever called by the drain loop. */
    private async downloadNext(): Promise<Attempt> {
        if (this.paused) {
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

            // Re-read rather than trust the listener: this is the gate that spends the user's data.
            // Allowlist (Wi-Fi / Ethernet), not "anything but cellular" - see tools/downloadStatus.ts.
            const networkState = await getNetworkStateAsync();
            this.network = networkState;

            if (!networkState.isInternetReachable || !isDownloadNetwork(networkState.type)) {
                return "blocked";
            }

            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

            if (hostAddress == null) {
                return "blocked";
            }

            // Make sure song isn't already downloaded
            const localSongUri = Downloader.generateLocalSongUri(song);

            if (await Downloader.fileExists(localSongUri)) {
                await DbQueries.removeFromDownloadQueue(this.db, song.songId);
                return "skipped";
            }

            // Download song
            this.downloading = true;
            this.songInFlight = { songId: song.songId, name: song.name };
            this.publishProgress(song.songId, 0);
            await this.publishStatus();
            const songFileName = Downloader.generateSongFileName(song);
            const songDownloadedPath = path.join(tempFolder, songFileName);
            const songDownloadResumable = FileSystem.createDownloadResumable(
                path.join(hostAddress, "music", songFileName),
                songDownloadedPath,
                {},
                ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
                    if (totalBytesExpectedToWrite > 0) {
                        this.publishProgress(song.songId, totalBytesWritten / totalBytesExpectedToWrite);
                    }
                },
            );
            const downloadedSongFile = await songDownloadResumable.downloadAsync();

            if (downloadedSongFile == undefined) {
                return "failed";
            }

            const verifiedSong = await verifyFileIntegrity(downloadedSongFile.uri)

            if (!verifiedSong) {
                // A 404/500 body or a truncated file lands here; leave nothing behind for the next attempt.
                await FileSystem.deleteAsync(downloadedSongFile.uri, { idempotent: true });
                return "failed";
            }

            // Download album art
            const albumArtFileName = `${song.fileHash}.jpg`;
            const albumArtDownloadedPath = path.join(tempFolder, albumArtFileName);
            const albumArtDownloadResumable = FileSystem.createDownloadResumable(
                path.join(hostAddress, "albumart", albumArtFileName),
                albumArtDownloadedPath);

            if (await Downloader.fileExists(localSongUri)) {
                await DbQueries.removeFromDownloadQueue(this.db, song.songId);
                return "skipped";
            }

            const downloadedAlbumArtFile = await albumArtDownloadResumable.downloadAsync();

            if (downloadedAlbumArtFile == undefined) {
                return "failed";
            }

            // Move song and art to respective folder
            await FileSystem.moveAsync({
                from: downloadedSongFile.uri,
                to: path.join(musicFolder, songFileName)
            });
            await FileSystem.moveAsync({
                from: downloadedAlbumArtFile.uri,
                to: path.join(albumArtFolder, albumArtFileName)
            });
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

    public static generateSongFileName(song: { fileHash: string, fileExtension: string }) {
        return `${song.fileHash}${song.fileExtension}`;
    }

    public static generateAlbumArtFileName(song: Song) {
        return `${song.fileHash}.jpg`;
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
            console.warn(`Failed to delete local files for replaced song ${song.songId}:`, e);
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
}
