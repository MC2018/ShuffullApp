// Pure logic behind the download status UI. No React Native imports so it can be unit-tested (see
// tests/downloadStatus.test.ts) and shared verbatim by the native and web Downloader builds.

/**
 * Network types the Downloader is willing to pull audio over. This is an ALLOWLIST on purpose: the old
 * check was `type != CELLULAR`, which let VPN / BLUETOOTH / UNKNOWN through and only blocked mobile data
 * because expo-network happens to test TRANSPORT_CELLULAR before TRANSPORT_VPN on Android 10+ (a VPN over
 * LTE therefore reports "CELLULAR"). On Android 9 the legacy path reports "VPN" and the denylist let it
 * download over mobile data. Naming what IS allowed makes the intent literal and fails closed for
 * anything unclassifiable. The string values match expo-network's NetworkStateType enum.
 */
export const DOWNLOAD_NETWORK_TYPES: ReadonlySet<string> = new Set(["WIFI", "ETHERNET"]);

export function isDownloadNetwork(type: string | undefined): boolean {
    return type != undefined && DOWNLOAD_NETWORK_TYPES.has(type);
}

export type DownloadPhase =
    | "idle" // nothing queued
    | "downloading" // a song is in flight, or one is about to start
    | "paused" // the user paused; nothing new starts (an in-flight song is allowed to finish)
    | "waiting-for-wifi" // queued, online, but not on an allowed network
    | "offline" // queued, no internet at all
    | "unsupported"; // web/desktop build: no local store

export interface DownloadStatus {
    phase: DownloadPhase;
    /** Song currently being fetched (may linger briefly while paused, see "paused" above). */
    current?: { songId: string; progress: number };
    /** Rows still in the queue, INCLUDING the in-flight one (it is only removed after it lands). */
    queuedCount: number;
    /** Bumped every time a song finishes downloading, so screens know to refresh their "downloaded" lists. */
    completedCount: number;
}

export interface NetworkSnapshot {
    isInternetReachable: boolean;
    type: string | undefined;
}

/**
 * The single place that decides what the Downloader is doing. `downloading` is the loop's own in-flight
 * flag; everything else is observed state. Pause wins over everything so the user sees that their choice
 * is in effect even while the current song finishes.
 */
export function derivePhase(input: {
    paused: boolean;
    downloading: boolean;
    queuedCount: number;
    network: NetworkSnapshot | undefined;
}): DownloadPhase {
    if (input.paused) {
        return "paused";
    }
    if (input.downloading) {
        return "downloading";
    }
    if (input.queuedCount <= 0) {
        return "idle";
    }
    if (input.network == undefined || !input.network.isInternetReachable) {
        return "offline";
    }
    if (!isDownloadNetwork(input.network.type)) {
        return "waiting-for-wifi";
    }
    return "downloading";
}

/** Shown under the status card and on the Library row so the policy is written down where it applies. */
export const WIFI_ONLY_NOTE = "Downloads only over Wi-Fi.";

/**
 * Headline for the status card. `currentName` is the in-flight song's title, when known. The "N of M"
 * form counts the in-flight song as the Nth (it is still in the queue), which reads as progress rather than
 * "remaining", matching how every other download manager phrases it.
 */
export function describeDownloadStatus(status: DownloadStatus, currentName?: string): { title: string; detail?: string } {
    const remaining = status.queuedCount;
    switch (status.phase) {
        case "idle":
            return { title: status.completedCount > 0 ? "All downloads complete" : "Nothing queued" };
        case "downloading": {
            const pct = status.current ? `${Math.round(status.current.progress * 100)}%` : undefined;
            return {
                title: remaining > 0 ? `Downloading ${remaining} ${remaining === 1 ? "song" : "songs"}` : "Downloading",
                detail: currentName ? (pct ? `${currentName} · ${pct}` : currentName) : "Starting…",
            };
        }
        case "paused":
            return {
                title: `Paused · ${remaining} queued`,
                detail: status.current && currentName ? `Finishing ${currentName}` : undefined,
            };
        case "waiting-for-wifi":
            return { title: `Waiting for Wi-Fi · ${remaining} queued` };
        case "offline":
            return { title: `Offline · ${remaining} queued` };
        case "unsupported":
            return { title: "Downloads aren't available on this platform" };
    }
}

/**
 * One-line subtitle for the Library › Downloads row: the ambient "is anything happening?" signal. Falls
 * back to the saved count when nothing is in flight.
 */
export function describeDownloadsRow(status: DownloadStatus, downloadedCount: number, currentName?: string): string {
    const saved = `${downloadedCount} ${downloadedCount === 1 ? "song" : "songs"} saved offline`;
    switch (status.phase) {
        case "downloading":
            return currentName ? `Downloading ${status.queuedCount} · ${currentName}` : `Downloading ${status.queuedCount}`;
        case "paused":
            return `Paused · ${status.queuedCount} queued`;
        case "waiting-for-wifi":
            return `Waiting for Wi-Fi · ${status.queuedCount} queued`;
        case "offline":
            return `Offline · ${status.queuedCount} queued`;
        case "unsupported":
            return "Not available on this platform";
        case "idle":
            return saved;
    }
}

/**
 * Whether the Downloader needs the process kept alive right now. Queued work that is not paused wants the
 * foreground service even while waiting for Wi-Fi — the network listener is what restarts the loop, and it
 * can only do that if the process is still there to hear it. Pausing releases the hold, except while a song
 * is mid-file: the queue row is still there and letting the hold drop would let Android kill the process
 * under a half-written temp file.
 *
 * Note what this deliberately does NOT do: start a service from the background. Android 12+ refuses that,
 * so the hold is acquired when work is enqueued/resumed (always a foreground action) and simply kept.
 */
export function shouldHoldForegroundService(input: { paused: boolean; downloading: boolean; queuedCount: number }): boolean {
    if (input.queuedCount <= 0) {
        return false;
    }
    return !input.paused || input.downloading;
}

export interface DownloadNotification {
    title: string;
    text: string;
    /** Whole percent (0–100) while a song is in flight; `indeterminate` before the first byte lands. */
    progress?: { max: number; value: number; indeterminate?: boolean };
}

/**
 * What the foreground-service notification says. Same words as the status card so the shade and the app
 * never disagree about what is happening.
 */
export function describeDownloadNotification(status: DownloadStatus, currentName?: string): DownloadNotification {
    const { title, detail } = describeDownloadStatus(status, currentName);
    const text = detail ?? WIFI_ONLY_NOTE;
    if (status.phase !== "downloading") {
        return { title, text };
    }
    if (status.current == undefined) {
        return { title, text, progress: { max: 100, value: 0, indeterminate: true } };
    }
    return { title, text, progress: { max: 100, value: Math.round(status.current.progress * 100) } };
}

/**
 * Delay before retrying after a failed download attempt. The loop chains songs back-to-back, so without
 * this a song that fails every time (404, hash mismatch) would be hammered continuously; with it the same
 * song is retried at 2 s, 4 s, ... capped at a minute, and the counter resets on any success.
 */
export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 60000;

export function retryDelayMs(consecutiveFailures: number): number {
    if (consecutiveFailures <= 0) {
        return 0;
    }
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (consecutiveFailures - 1));
}
