import { Platform } from "react-native";
import { GenericDb } from "../db/GenericDb";
import { desktopShell } from "../desktopShell";
import { MediaManager } from "../media-manager";
import { createSerialLock } from "../../tools/serialLock";
import { AUTO_DOWNLOAD_INTERVAL_MS } from "../../tools/autoDownloads";
import { Downloader } from "./Downloader";
import { reconcileAutoDownloads, ReconcileResult } from "./reconcileAutoDownloads";

// A big removal deletes many files; that is slow, not stuck. The lock only has to stop two runs overlapping.
const MAX_RUN_MS = 2 * 60 * 1000;
// Sync runs every 10 seconds. A run after sync is only there to notice a like or a new mix sooner than the interval
// would, and the delay is 10 minutes anyway, so one a minute is plenty.
const AFTER_SYNC_MIN_GAP_MS = 60 * 1000;

/**
 * Runs the auto-download reconciler (ShuffullApp#225) every few minutes and after every sync, for the signed-in user.
 * A process-wide singleton like the Downloader, so a run isn't tied to a screen. Runs one at a time; a run asked for
 * while one is going waits its turn and then reads fresh state, so nothing is lost by asking twice.
 *
 * With the rules Off (the default) a run still happens, and removes nothing but earlier automatic downloads (after
 * the delay). Hand-picked downloads are never touched.
 */
export class AutoDownloader {
    private static instance: AutoDownloader | undefined;

    public static shared(db: GenericDb): AutoDownloader {
        if (AutoDownloader.instance == undefined) {
            AutoDownloader.instance = new AutoDownloader(db);
        }
        return AutoDownloader.instance;
    }

    private readonly lock = createSerialLock({ name: "auto-downloads", maxHoldMs: MAX_RUN_MS });
    private userId: string | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private lastRunStartedMs = 0;
    /** The last run's outcome, for the dev hook on the settings screen. */
    lastResult: (ReconcileResult & { atMs: number }) | undefined;

    private constructor(private readonly db: GenericDb) {}

    /** Starts running for this user: now, then on the interval. */
    public start(userId: string) {
        this.userId = userId;
        if (this.timer == undefined) {
            this.timer = setInterval(() => void this.run(), AUTO_DOWNLOAD_INTERVAL_MS);
        }
        void this.run();
    }

    /** Stops, unless another user has started it since (a fast account switch). */
    public stop(userId: string) {
        if (this.userId !== userId) {
            return;
        }
        this.userId = undefined;
        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** A run after a sync, skipped if one started within the last minute. */
    public runAfterSync() {
        if (Date.now() - this.lastRunStartedMs >= AFTER_SYNC_MIN_GAP_MS) {
            void this.run();
        }
    }

    /**
     * One run. Never rejects. Resolves undefined when there was nothing to run for. `delayMs` overrides the 10-minute
     * hold, for the developer hook on the settings screen only.
     */
    public run(options?: { delayMs?: number }): Promise<ReconcileResult | undefined> {
        return this.lock.run(() => this.runLocked(options?.delayMs));
    }

    private async runLocked(delayMs: number | undefined): Promise<ReconcileResult | undefined> {
        const userId = this.userId;
        if (userId == undefined || !downloadsSupported()) {
            return undefined;
        }
        this.lastRunStartedMs = Date.now();
        try {
            const result = await reconcileAutoDownloads({
                db: this.db,
                userId,
                nowMs: Date.now(),
                protectedIds: MediaManager.protectedSongIds(),
                deleteFiles: (song) => Downloader.deleteLocalSongFiles(song),
                delayMs,
            });
            this.lastResult = { ...result, atMs: Date.now() };
            if (result.enqueued > 0 || result.removed > 0) {
                console.log(`[auto-downloads] queued ${result.enqueued}, removed ${result.removed}, ${result.waiting} waiting out the delay`);
                await Downloader.shared(this.db).notifyQueueChanged();
            }
            return result;
        } catch (e) {
            console.warn("[auto-downloads] run failed; the next one retries", e);
            return undefined;
        }
    }
}

/** Phones, and the desktop app. A plain browser has nowhere to keep a download. */
function downloadsSupported(): boolean {
    return Platform.OS !== "web" || desktopShell()?.media != undefined;
}
