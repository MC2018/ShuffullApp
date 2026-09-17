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
