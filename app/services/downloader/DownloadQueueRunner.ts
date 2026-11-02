import DbQueries from "../db/queries";
import { GenericDb } from "../db/GenericDb";
import { DownloadPriority } from "../db/types";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { MediaKind } from "../../tools/desktopMedia";
import { useDownloadStatus } from "./downloadStatus";
import { derivePhase, describeDownloadNotification, DownloadNotification, NetworkSnapshot, retryDelayMs, shouldHoldForegroundService } from "../../tools/downloadStatus";
import { decideArtDownload, decideSongDownload } from "../../tools/downloadFailure";
import { createDiskReconciler, ListSongFiles } from "./reconcileDownloads";
import { log } from "../../tools/log";

/**
 * What one fetch came back with, in the shape decideSongDownload reads. Undefined when there was no response at all
 * (interrupted, cancelled). `hashMatches` is only reported for a song: album art is never hash-checked.
 */
export type DownloadResult = { status: number; hashMatches?: boolean } | undefined;

/**
 * Everything the download loop needs from a platform. Platform-free on purpose, so the loop can be unit-tested
 * against a fake (tests/downloadQueueRunner.test.ts). Two adapters exist: nativeDownloadAdapter.ts (expo-file-system,
 * the Wi-Fi allowlist, the foreground service) and desktopDownloadAdapter.ts (the Electron shell's media store).
 */
export interface DownloadAdapter {
    /** Whether downloads wait for Wi-Fi/Ethernet (see DownloadStatus.wifiOnly). */
    readonly wifiOnly: boolean;
    exists(kind: MediaKind, fileName: string): Promise<boolean>;
    /**
     * Fetches `<host>/<kind>/<fileName>` into the store. The file lands in place only when the fetch succeeded
     * (a 2xx and, when `verify`, the hash matched), so a failure never leaves anything `exists` would see.
     * May throw; the loop counts that as a failure to retry.
     */
    download(host: string, kind: MediaKind, fileName: string, verify: boolean, onProgress: (fraction: number) => void): Promise<DownloadResult>;
    /** The gate that spends the user's data. Re-read right before every download, never cached. */
    canDownloadNow(): Promise<boolean>;
    /** The last network state seen, for the published phase only. */
    network(): Promise<NetworkSnapshot>;
    /** Lists the music folder, for reconcileWithDisk. */
    listSongFiles: ListSongFiles;
    /** Runs once at start, before anything touches the store (native creates its folders here). */
    prepare?(): Promise<void>;
    /** Subscribes to whatever can make waiting work startable: the network changing, the app coming back. */
    watch?(onChange: () => void): void;
    /** Keeps the process alive while there is work. Native only: the Electron window keeps the renderer alive. */
    background?: BackgroundHold;
}

export interface BackgroundHold {
    hold(notification: DownloadNotification): void;
    release(): void;
    isHeld(): boolean;
    /** Runs before work the user just asked for: the one moment a permission prompt makes sense. */
    prepareForUserWork(): Promise<void>;
}

/** The slice of AsyncStorage the loop uses; a Map does in tests. */
export interface KeyValueStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

export interface DownloadQueueRunnerOptions {
    db: GenericDb;
    /** Undefined on a host with no local store (a plain browser): the status says "unsupported" and every call is a no-op. */
    adapter: DownloadAdapter | undefined;
    storage: KeyValueStorage;
    /** The backoff wait. Tests pass one that doesn't really wait. */
    sleep?: (ms: number) => Promise<void>;
}

// Safety net only. Every event that can create work (enqueue, resume, network change, app foregrounded)
// kicks the loop directly; this just catches anything that slipped through.
const WATCHDOG_MS = 10000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function songFileName(song: { fileHash: string; fileExtension: string }): string {
    return `${song.fileHash}${song.fileExtension}`;
}

export function albumArtFileName(song: { fileHash: string }): string {
    return `${song.fileHash}.jpg`;
}

/**
 * Outcome of one attempt at the head of the queue, which is what decides whether the loop keeps going:
 *   downloaded – a song landed; go straight to the next one
 *   skipped    – the row was dropped: song gone locally, already on disk, or a failure that will never
 *                succeed (404, repeated hash mismatch - see tools/downloadFailure.ts); go on
 *   blocked    – nothing to do or not allowed to (empty, paused, no network, no host); stop and wait for an event
 *   failed     – a failure that may clear up (5xx, interrupted, exception), or a drop deferred because too many
 *                came in a row; the row stays and the next try waits out a backoff
 */
export type Attempt = "downloaded" | "skipped" | "blocked" | "failed";

/**
 * Drains the download queue: the loop, the status it publishes, the progress throttle and the failure rules, shared
 * by the native and desktop Downloaders (each is this class plus its adapter). One instance per process, made by
 * `Downloader.shared`, never by a React component: on Android, swiping the app away unmounts the whole tree while
 * the foreground service keeps the process alive, so a loop owned by a component would silently stop under a
 * notification still claiming it was running.
 *
 * Background execution (native): while there is queued work the runner holds the adapter's background hold (the
 * shared foreground service), which keeps JS timers and the process alive after Home or swipe-away, and publishes
 * "Downloading N songs · title · 42%" to it. The hold is released when the queue drains or the user pauses.
 */
export class DownloadQueueRunner {
    private readonly db: GenericDb;
    private readonly adapter: DownloadAdapter | undefined;
    private readonly storage: KeyValueStorage;
    private readonly sleep: (ms: number) => Promise<void>;
    // The drain loop while it runs (between songs included), so a kick cannot start a second loop.
    private drainRun: Promise<void> | undefined;
    // A kick arrived while drainRun was set. The loop may already be past its last queue read (publishing why it
    // stopped), so it goes round once more rather than leave that work to the watchdog.
    private kickRequested = false;
    // True only while a song is in flight; drives the "downloading" phase and the pause-with-in-flight hold.
    downloading = false;
    // Starts true so nothing can start before the persisted value is read (start() flips it).
    paused = true;
    private songInFlight: { songId: string; name: string } | undefined;
    private consecutiveFailures = 0;
    // Per-song count of 2xx downloads whose hash didn't match (see decideSongDownload). In memory on purpose:
    // a restart just grants a few more attempts.
    private hashMismatches = new Map<string, number>();
    // Rows dropped since the last song that actually downloaded; bounds a failure that hits every song alike.
    private consecutiveDrops = 0;
    // Matches downloaded_songs to the music folder (see reconcileWithDisk).
    private readonly reconcile: () => Promise<void>;
    private watchdog: ReturnType<typeof setInterval> | undefined;

    constructor(options: DownloadQueueRunnerOptions) {
        this.db = options.db;
        this.adapter = options.adapter;
        this.storage = options.storage;
        this.sleep = options.sleep ?? defaultSleep;
        const adapter = this.adapter;
        this.reconcile = adapter == undefined
            ? async () => {}
            : createDiskReconciler(this.db, fileNames => adapter.listSongFiles(fileNames), songFileName);
    }

    /**
     * Starts the watchdog and the event subscriptions, reads the persisted pause, kicks the loop and makes the
     * Downloads list match the disk. Resolves once all of that has run, not when the queue drains.
     */
    public async start(): Promise<void> {
        const adapter = this.adapter;
        if (adapter == undefined) {
            // A plain browser: say honestly that there is nothing to manage here.
            useDownloadStatus.getState().setStatus({ phase: "unsupported", queuedCount: 0, current: undefined });
            return;
        }
        useDownloadStatus.getState().setStatus({ wifiOnly: adapter.wifiOnly });

        this.watchdog = setInterval(() => {
            void this.kick();
            // Even when nothing runs, keep the published phase honest (queue count, network).
            void this.publishStatus();
        }, WATCHDOG_MS);

        // Show "waiting for Wi-Fi" / "offline" the moment the network changes rather than on the next tick, and
        // restart the loop when it comes back, which is the whole point of holding the service while waiting.
        adapter.watch?.(() => {
            void this.publishStatus();
            void this.kick();
        });

        try {
            await adapter.prepare?.();
        } catch (e) {
            log.warn("downloader", "couldn't prepare the download folders", e);
        }

        // Pause is a user decision, so it survives restarts (see CLAUDE.md "durability before enrichment"
        // - same principle at a smaller scale: the choice lives in storage, not in whatever the loop last did).
        // Reading it also (re)acquires the background hold if the last run was killed with work still queued.
        this.paused = (await this.storage.getItem(STORAGE_KEYS.DOWNLOADS_PAUSED)) === "1";
        await this.publishStatus();
        void this.kick();
        await this.reconcileWithDisk();
    }

    /** Stops the watchdog. For tests; the app's runner lives as long as the JS context. */
    public dispose() {
        if (this.watchdog != undefined) {
            clearInterval(this.watchdog);
            this.watchdog = undefined;
        }
    }

    /**
     * Records every song whose file is in the music folder and forgets every row whose file is gone
     * (see reconcileDownloads.ts). Runs at start-up, after a sync brings new songs, and when the Downloads screen
     * opens. Only rows change, never files. Never throws: a folder that can't be read leaves the rows as they are.
     */
    public reconcileWithDisk(): Promise<void> {
        return this.reconcile();
    }

    /** Stops starting NEW downloads. A song already in flight is allowed to finish (they are single files). */
    public async pause() {
        if (this.adapter == undefined) {
            return;
        }
        this.paused = true;
        await this.storage.setItem(STORAGE_KEYS.DOWNLOADS_PAUSED, "1");
        await this.publishStatus();
    }

    public async resume() {
        if (this.adapter == undefined) {
            return;
        }
        this.paused = false;
        await this.storage.setItem(STORAGE_KEYS.DOWNLOADS_PAUSED, "0");
        await this.adapter.background?.prepareForUserWork();
        await this.publishStatus();
        // Don't make the user wait out the timer to see it start.
        void this.kick();
    }

    public async removeFromQueue(songId: string) {
        if (this.adapter == undefined) {
            return;
        }
        await DbQueries.removeFromDownloadQueue(this.db, songId);
        await this.publishStatus();
    }

    public async clearQueue() {
        if (this.adapter == undefined) {
            return;
        }
        await DbQueries.removeAllFromDownloadQueue(this.db);
        this.startNewRun();
        await this.publishStatus();
    }

    public async addSongToDownloadQueue(songId: string, priority: DownloadPriority) {
        if (this.adapter == undefined) {
            return;
        }
        await DbQueries.addToDownloadQueue(this.db, [songId], priority);
        this.startNewRun();
        await this.adapter.background?.prepareForUserWork();
        await this.publishStatus();
        void this.kick();
    }

    /** Returns what happened so the button can say so: how many were queued vs. already on disk. */
    public async addPlaylistToDownloadQueue(playlistId: string, priority: DownloadPriority): Promise<{ queued: number; alreadyDownloaded: number }> {
        const adapter = this.adapter;
        if (adapter == undefined) {
            return { queued: 0, alreadyDownloaded: 0 };
        }
        const songs = await DbQueries.getSongsByPlaylist(this.db, playlistId);
        const toQueue: string[] = [];
        const alreadyDownloaded: string[] = [];

        for (const song of songs) {
            if (await adapter.exists("music", songFileName(song))) {
                alreadyDownloaded.push(song.songId);
            } else {
                toQueue.push(song.songId);
            }
        }

        // Not queued, but recorded: a file already on disk is a download, even if no row says so yet.
        await DbQueries.addDownloadedSongs(this.db, alreadyDownloaded);
        await DbQueries.addToDownloadQueue(this.db, toQueue, priority);
        if (toQueue.length > 0) {
            this.startNewRun();
            await adapter.background?.prepareForUserWork();
        }
        await this.publishStatus();
        void this.kick();
        return { queued: toQueue.length, alreadyDownloaded: alreadyDownloaded.length };
    }

    /** New work (or a cleared queue) starts a new run, so "Skipped N" describes this run, not every one since launch. */
    private startNewRun() {
        useDownloadStatus.getState().setStatus({ skippedCount: 0 });
    }

    /**
     * Starts the drain loop if it isn't already running. Safe to call from anywhere, any number of times. Resolves
     * when the running loop stops; callers in the app don't wait for that, tests do.
     */
    public kick(): Promise<void> {
        if (this.adapter == undefined) {
            return Promise.resolve();
        }
        this.kickRequested = true;
        this.drainRun ??= (async () => {
            try {
                while (this.kickRequested) {
                    this.kickRequested = false;
                    await this.drain();
                }
            } finally {
                this.drainRun = undefined;
            }
        })();
        return this.drainRun;
    }

    /**
     * Runs songs back-to-back until there is nothing to do. One loop at a time (`drainRun`); every path out goes
     * through publishStatus so the store and the notification reflect why it stopped.
     */
    private async drain() {
        try {
            while (!this.paused) {
                const attempt = await this.downloadNext();

                if (attempt === "blocked") {
                    break;
                }

                if (attempt === "failed") {
                    this.consecutiveFailures++;
                    await this.sleep(retryDelayMs(this.consecutiveFailures));
                } else {
                    this.consecutiveFailures = 0;
                }
            }
        } finally {
            await this.publishStatus();
        }
    }

    /**
     * Recomputes the observable status from the queue, the loop's own flags and the last network state,
     * then mirrors it to the background hold. Cheap (one COUNT), and the only writer of the store apart from
     * the in-flight progress callback.
     */
    private async publishStatus() {
        const adapter = this.adapter;
        if (adapter == undefined) {
            return;
        }
        try {
            const queuedCount = await DbQueries.countDownloadQueue(this.db);
            const phase = derivePhase({
                paused: this.paused,
                downloading: this.downloading,
                queuedCount,
                network: await adapter.network(),
                wifiOnly: adapter.wifiOnly,
            });
            const current = useDownloadStatus.getState().status.current;
            useDownloadStatus.getState().setStatus({
                phase,
                queuedCount,
                // Keep the progress the callback wrote; only clear it once nothing is in flight.
                current: this.songInFlight ? (current?.songId === this.songInFlight.songId ? current : { songId: this.songInFlight.songId, progress: 0 }) : undefined,
            });
            this.syncBackgroundHold(adapter.background, queuedCount);
        } catch (e) {
            log.warn("downloader", "failed to publish status", e);
        }
    }

    private syncBackgroundHold(background: BackgroundHold | undefined, queuedCount: number) {
        if (background == undefined) {
            return;
        }
        if (!shouldHoldForegroundService({ paused: this.paused, downloading: this.downloading, queuedCount })) {
            background.release();
            return;
        }
        background.hold(describeDownloadNotification(useDownloadStatus.getState().status, this.songInFlight?.name));
    }

    private publishProgress(songId: string, progress: number) {
        const current = useDownloadStatus.getState().status.current;
        // Throttle to whole-percent changes so a large file doesn't re-render the screen (or re-post the
        // notification) hundreds of times.
        if (current?.songId === songId && Math.round(current.progress * 100) === Math.round(progress * 100)) {
            return;
        }
        useDownloadStatus.getState().setStatus({ current: { songId, progress } });
        const background = this.adapter?.background;
        if (background?.isHeld()) {
            background.hold(describeDownloadNotification(useDownloadStatus.getState().status, this.songInFlight?.name));
        }
    }

    /** One attempt at the head of the queue. Only ever called by the drain loop. */
    private async downloadNext(): Promise<Attempt> {
        const adapter = this.adapter;
        if (this.paused || adapter == undefined) {
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

            if (!(await adapter.canDownloadNow())) {
                return "blocked";
            }

            const hostAddress = await this.storage.getItem(STORAGE_KEYS.HOST_ADDRESS);

            if (hostAddress == null) {
                return "blocked";
            }

            const songFile = songFileName(song);

            // Already in the music folder: an earlier run moved it in, then died before recording it. Record it
            // rather than just dropping the row, or it is on disk but never listed or offered offline.
            if (await adapter.exists("music", songFile)) {
                await this.recordDownloaded(song.songId);
                return "skipped";
            }

            this.downloading = true;
            this.songInFlight = { songId: song.songId, name: song.name };
            this.publishProgress(song.songId, 0);
            await this.publishStatus();

            // Album art BEFORE the audio, because a song file in the music folder is what counts as downloaded (the
            // check above, and reconcileWithDisk): once it is there nothing fetches the art after the fact, and the
            // server-URL fallback only works online, which is not when a downloaded song is played. So a song the
            // server has no art for goes on without it, and a transient art failure retries the whole song (see
            // decideArtDownload). Art a previous attempt already stored isn't fetched again.
            const artFile = albumArtFileName(song);

            if (!(await adapter.exists("albumart", artFile))) {
                const artResult = await adapter.download(hostAddress, "albumart", artFile, false, () => {});
                const art = decideArtDownload(artResult);

                if (art === "retry") {
                    log.warn("downloader", `will retry ${song.songId} (${song.name}): album art returned ${artResult?.status ?? "no result"}`);
                    return "failed";
                }

                if (art === "without") {
                    log.warn("downloader", `no album art for ${song.songId} (status ${artResult?.status}); saving the song without it`);
                }
            }

            const result = await adapter.download(hostAddress, "music", songFile, true, (fraction) => this.publishProgress(song.songId, fraction));
            const decision = decideSongDownload(result, {
                hashMismatches: this.hashMismatches.get(song.songId) ?? 0,
                consecutiveDrops: this.consecutiveDrops,
            });

            if (decision.action === "retry") {
                this.hashMismatches.set(song.songId, decision.hashMismatches);
                log.warn("downloader", `will retry ${song.songId} (${song.name}): ${decision.reason}`);
                return "failed";
            }

            this.hashMismatches.delete(song.songId);

            if (decision.action === "defer") {
                // Back off as for any failure, but from the back of the queue, so the songs behind this one get
                // their turn - one of them downloading is what shows the server is fine and lets drops resume.
                log.warn("downloader", `deferring ${song.songId} (${song.name}) to the back of the download queue: ${decision.reason}`);
                await DbQueries.moveToBackOfDownloadQueue(this.db, song.songId);
                return "failed";
            }

            if (decision.action === "drop") {
                // Not marked downloaded: the song stays in the library and can be queued again. Art stored for it
                // above is left in place on purpose: it is small, keyed by the same hash, reused if the song is
                // queued again, and deleteLocalSongFiles removes it with the song.
                log.warn("downloader", `skipping ${song.songId} (${song.name}), removed from the download queue: ${decision.reason}`);
                this.consecutiveDrops++;
                await DbQueries.removeFromDownloadQueue(this.db, song.songId);
                useDownloadStatus.getState().setStatus({ skippedCount: useDownloadStatus.getState().status.skippedCount + 1 });
                return "skipped";
            }

            await this.recordDownloaded(song.songId);
            this.consecutiveDrops = 0;
            useDownloadStatus.getState().setStatus({ completedCount: useDownloadStatus.getState().status.completedCount + 1 });
            return "downloaded";
        } catch (e) {
            log.error("downloader", "attempt failed", e);
            return "failed";
        } finally {
            this.downloading = false;
            this.songInFlight = undefined;
            await this.publishStatus();
        }
    }

    private async recordDownloaded(songId: string) {
        await DbQueries.addDownloadedSong(this.db, songId);
        await DbQueries.removeFromDownloadQueue(this.db, songId);
    }
}
