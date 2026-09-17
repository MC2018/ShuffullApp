import { AppState, AppStateStatus, Platform } from "react-native";
import BackgroundService from "react-native-background-actions";

/**
 * The one owner of the Android foreground service.
 *
 * `react-native-background-actions` is a SINGLETON service: a second `start()` while one is running does
 * not start a second service, it re-runs `onStartCommand` on the same one (spawning another headless task)
 * and `stop()` tears the single service down for everyone. So two independent callers cannot each "have"
 * a service — they would fight over one notification and one stop button. This module replaces direct use
 * of the library with named HOLDS: the first hold starts the service, the last release stops it, and the
 * notification shows whichever hold matters most.
 *
 * Why the app needs it at all: on Android, React Native stops firing JS timers when the activity is
 * paused unless a headless task is active (`JavaTimerManager.onHostPause`). A foreground service is that
 * headless task (so is react-native-track-player's MusicService, which is why timers already run while
 * music plays) — it is what lets downloads continue after the user presses Home. It also keeps the PROCESS
 * alive after the user swipes the app away; what it cannot do is keep the React tree alive, which is why
 * long-running work must not be owned by a component (see Downloader).
 *
 * Android 15+ caps `dataSync` services at 6 hours per 24 h, counted while running, reset whenever the app
 * comes to the foreground. On expiry the service stops itself and JS is not told. Re-asserting the holds
 * when the app becomes active is what recovers from that — and it is cheap, because that is also the
 * moment the budget resets.
 */
export type HoldKey = "downloads";

export interface HoldNotification {
    title: string;
    text: string;
    progress?: { max: number; value: number; indeterminate?: boolean };
}

// Higher wins the notification when several holds are active. One key today; the map is the extension point.
const PRIORITY: Record<HoldKey, number> = { downloads: 1 };

const SUPPORTED = Platform.OS === "android";

class ForegroundService {
    private holds = new Map<HoldKey, HoldNotification>();
    private running = false;
    private shown: HoldNotification | undefined;
    // Every headless task we have started (re-asserts add more) waits on one of these; releasing the last
    // hold resolves them all so the library can finish cleanly.
    private taskResolvers: (() => void)[] = [];
    // start/stop/update are serialised through this chain so a quick hold→release→hold cannot interleave
    // a stop after a later start.
    private chain: Promise<void> = Promise.resolve();

    constructor() {
        if (SUPPORTED) {
            AppState.addEventListener("change", (state) => this.onAppState(state));
        }
    }

    /** Acquire or update a hold. Idempotent: calling it with unchanged text is a no-op. */
    hold(key: HoldKey, notification: HoldNotification): void {
        if (!SUPPORTED) {
            return;
        }
        this.holds.set(key, notification);
        this.enqueue(() => this.apply());
    }

    release(key: HoldKey): void {
        if (!SUPPORTED) {
            return;
        }
        if (this.holds.delete(key)) {
            this.enqueue(() => this.apply());
        }
    }

    isHeld(key: HoldKey): boolean {
        return this.holds.has(key);
    }

    private enqueue(step: () => Promise<void>) {
        this.chain = this.chain.then(step).catch((e) => console.warn("[foreground-service]", e));
    }

    private current(): HoldNotification | undefined {
        let best: { key: HoldKey; notification: HoldNotification } | undefined;
        for (const [key, notification] of this.holds) {
            if (best == undefined || PRIORITY[key] > PRIORITY[best.key]) {
                best = { key, notification };
            }
        }
        return best?.notification;
    }

    private async apply() {
        const wanted = this.current();

        if (wanted == undefined) {
            if (this.running) {
                await this.stop();
            }
            return;
        }

        if (!this.running) {
            await this.start(wanted);
            return;
        }

        if (!sameNotification(this.shown, wanted)) {
            this.shown = wanted;
            await BackgroundService.updateNotification(toOptions(wanted));
        }
    }

    private async start(notification: HoldNotification) {
        try {
            await BackgroundService.start(() => this.waitForRelease(), {
                taskName: "ShuffullForeground",
                ...toOptions(notification),
                taskIcon: { name: "ic_stat_download", type: "drawable" },
                foregroundServiceType: ["dataSync"],
            });
            this.running = true;
            this.shown = notification;
        } catch (e) {
            // Android 12+ refuses a foreground service started from the background; the native side already
            // stopped itself. Nothing to retry — the next foreground re-assert will try again.
            console.warn("[foreground-service] could not start; background work pauses until the app is opened", e);
        }
    }

    private async stop() {
        this.running = false;
        this.shown = undefined;
        this.resolveTasks();
        await BackgroundService.stop();
    }

    private waitForRelease(): Promise<void> {
        return new Promise((resolve) => this.taskResolvers.push(resolve));
    }

    private resolveTasks() {
        const resolvers = this.taskResolvers;
        this.taskResolvers = [];
        resolvers.forEach((resolve) => resolve());
    }

    private onAppState(state: AppStateStatus) {
        if (state !== "active") {
            return;
        }
        // Re-assert: if the service timed out (or the OS stopped it) while we still believe it is running,
        // this restarts it; if it is running, it merely re-posts the notification.
        this.enqueue(async () => {
            const wanted = this.current();
            if (wanted != undefined && this.running) {
                await this.start(wanted);
            }
        });
    }
}

function toOptions(notification: HoldNotification) {
    return {
        taskTitle: notification.title,
        taskDesc: notification.text,
        // Explicit undefined on purpose: updateNotification spreads over the previous options, so an
        // OMITTED key would keep the old bar. The library always sends the key; a null crosses fine
        // (Bundle.getBundle returns null for it) and clears the bar.
        progressBar: notification.progress,
    };
}

function sameNotification(a: HoldNotification | undefined, b: HoldNotification): boolean {
    return a != undefined
        && a.title === b.title
        && a.text === b.text
        && a.progress?.max === b.progress?.max
        && a.progress?.value === b.progress?.value
        && a.progress?.indeterminate === b.progress?.indeterminate;
}

export const foregroundService = new ForegroundService();
