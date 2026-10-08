import { describe, it, expect } from "vitest";
import {
    derivePhase,
    describeDownloadStatus,
    describeDownloadsRow,
    isDownloadNetwork,
    DownloadStatus,
    shouldHoldForegroundService,
    describeDownloadNotification,
    retryDelayMs,
    WIFI_ONLY_NOTE,
} from "@/app/tools/downloadStatus";

// Why an allowlist: the old gate was `type != CELLULAR`. On Android 10+ a VPN over LTE reports CELLULAR only
// because expo-network tests TRANSPORT_CELLULAR before TRANSPORT_VPN; on Android 9 the legacy path reports VPN
// and the denylist downloaded over mobile data. These pin the intent: Wi-Fi/Ethernet and nothing else.
describe("isDownloadNetwork", () => {
    it("allows Wi-Fi and Ethernet", () => {
        expect(isDownloadNetwork("WIFI")).toBe(true);
        expect(isDownloadNetwork("ETHERNET")).toBe(true);
    });

    it("blocks cellular, VPN, bluetooth, unknown, none and undefined", () => {
        for (const type of ["CELLULAR", "VPN", "BLUETOOTH", "WIMAX", "UNKNOWN", "NONE", "OTHER", undefined]) {
            expect(isDownloadNetwork(type)).toBe(false);
        }
    });
});

describe("derivePhase", () => {
    const wifi = { isInternetReachable: true, type: "WIFI" };
    const lte = { isInternetReachable: true, type: "CELLULAR" };

    it("pause wins over everything, including an in-flight download", () => {
        expect(derivePhase({ paused: true, downloading: true, queuedCount: 5, network: wifi })).toBe("paused");
        expect(derivePhase({ paused: true, downloading: false, queuedCount: 0, network: wifi })).toBe("paused");
    });

    it("reports downloading while a song is in flight regardless of the current network reading", () => {
        // The gate is evaluated before starting; a network flip mid-file doesn't change what is happening now.
        expect(derivePhase({ paused: false, downloading: true, queuedCount: 1, network: lte })).toBe("downloading");
    });

    it("is idle with an empty queue, whatever the network", () => {
        expect(derivePhase({ paused: false, downloading: false, queuedCount: 0, network: lte })).toBe("idle");
        expect(derivePhase({ paused: false, downloading: false, queuedCount: 0, network: undefined })).toBe("idle");
    });

    it("distinguishes offline from wrong-network when work is queued", () => {
        expect(derivePhase({ paused: false, downloading: false, queuedCount: 3, network: { isInternetReachable: false, type: "WIFI" } })).toBe("offline");
        expect(derivePhase({ paused: false, downloading: false, queuedCount: 3, network: undefined })).toBe("offline");
        expect(derivePhase({ paused: false, downloading: false, queuedCount: 3, network: lte })).toBe("waiting-for-wifi");
        expect(derivePhase({ paused: false, downloading: false, queuedCount: 3, network: { isInternetReachable: true, type: "VPN" } })).toBe("waiting-for-wifi");
    });

    it("is downloading when queued, online and on Wi-Fi even before the loop picks the song up", () => {
        expect(derivePhase({ paused: false, downloading: false, queuedCount: 3, network: wifi })).toBe("downloading");
    });
});

function status(patch: Partial<DownloadStatus>): DownloadStatus {
    return { phase: "idle", queuedCount: 0, completedCount: 0, skippedCount: 0, ...patch };
}

describe("describeDownloadStatus", () => {
    it("shows the song and a whole percent while downloading", () => {
        const s = status({ phase: "downloading", queuedCount: 12, current: { songId: "a", progress: 0.4321 } });
        expect(describeDownloadStatus(s, "Blue Train")).toEqual({ title: "Downloading 12 songs", detail: "Blue Train · 43%" });
    });

    it("says it is starting when the loop hasn't picked a song yet", () => {
        expect(describeDownloadStatus(status({ phase: "downloading", queuedCount: 1 })).detail).toBe("Starting…");
        expect(describeDownloadStatus(status({ phase: "downloading", queuedCount: 1 })).title).toBe("Downloading 1 song");
    });

    it("tells the user an in-flight song is finishing after they paused", () => {
        const s = status({ phase: "paused", queuedCount: 4, current: { songId: "a", progress: 0.5 } });
        expect(describeDownloadStatus(s, "Blue Train")).toEqual({ title: "Paused · 4 queued", detail: "Finishing Blue Train" });
        expect(describeDownloadStatus(status({ phase: "paused", queuedCount: 4 })).detail).toBeUndefined();
    });

    it("distinguishes a fresh idle from one that just finished work", () => {
        expect(describeDownloadStatus(status({ phase: "idle" })).title).toBe("Nothing queued");
        expect(describeDownloadStatus(status({ phase: "idle", completedCount: 3 })).title).toBe("All downloads complete");
        expect(describeDownloadStatus(status({ phase: "idle", completedCount: 3 })).detail).toBeUndefined();
    });

    it("says when the queue finished by giving up on songs", () => {
        expect(describeDownloadStatus(status({ phase: "idle", completedCount: 3, skippedCount: 1 })).detail).toBe("Skipped 1 song the server couldn't provide");
        expect(describeDownloadStatus(status({ phase: "idle", skippedCount: 5 }))).toEqual({
            title: "Nothing queued",
            detail: "Skipped 5 songs the server couldn't provide",
        });
    });

    it("names the network conditions", () => {
        expect(describeDownloadStatus(status({ phase: "waiting-for-wifi", queuedCount: 2 })).title).toBe("Waiting for Wi-Fi · 2 queued");
        expect(describeDownloadStatus(status({ phase: "offline", queuedCount: 2 })).title).toBe("Offline · 2 queued");
    });
});

describe("describeDownloadsRow", () => {
    it("falls back to the saved count when idle", () => {
        expect(describeDownloadsRow(status({}), 0)).toBe("0 songs saved offline");
        expect(describeDownloadsRow(status({}), 1)).toBe("1 song saved offline");
        expect(describeDownloadsRow(status({}), 142)).toBe("142 songs saved offline");
    });

    it("leads with what is happening otherwise", () => {
        expect(describeDownloadsRow(status({ phase: "downloading", queuedCount: 3, current: { songId: "a", progress: 0 } }), 10, "Blue Train")).toBe("Downloading 3 · Blue Train");
        expect(describeDownloadsRow(status({ phase: "downloading", queuedCount: 3 }), 10)).toBe("Downloading 3");
        expect(describeDownloadsRow(status({ phase: "paused", queuedCount: 3 }), 10)).toBe("Paused · 3 queued");
        expect(describeDownloadsRow(status({ phase: "waiting-for-wifi", queuedCount: 3 }), 10)).toBe("Waiting for Wi-Fi · 3 queued");
        expect(describeDownloadsRow(status({ phase: "offline", queuedCount: 3 }), 10)).toBe("Offline · 3 queued");
    });
});

describe("shouldHoldForegroundService", () => {
    it("holds while there is queued work, even if the network is currently blocking it", () => {
        // The hold is what keeps the process alive to hear the Wi-Fi-back event; the phase can be
        // waiting-for-wifi or offline and the answer is still yes.
        expect(shouldHoldForegroundService({ paused: false, downloading: false, queuedCount: 3 })).toBe(true);
        expect(shouldHoldForegroundService({ paused: false, downloading: true, queuedCount: 1 })).toBe(true);
    });

    it("releases once the queue is empty", () => {
        expect(shouldHoldForegroundService({ paused: false, downloading: false, queuedCount: 0 })).toBe(false);
    });

    it("releases on pause, but only after the in-flight song has landed", () => {
        expect(shouldHoldForegroundService({ paused: true, downloading: true, queuedCount: 4 })).toBe(true);
        expect(shouldHoldForegroundService({ paused: true, downloading: false, queuedCount: 4 })).toBe(false);
    });
});

describe("describeDownloadNotification", () => {
    const base: DownloadStatus = { phase: "downloading", queuedCount: 12, completedCount: 0, skippedCount: 0 };

    it("mirrors the status card and adds a determinate bar at the whole percent", () => {
        const n = describeDownloadNotification({ ...base, current: { songId: "s", progress: 0.426 } }, "Freestyle");
        expect(n.title).toBe("Downloading 12 songs");
        expect(n.text).toBe("Freestyle · 43%");
        expect(n.progress).toEqual({ max: 100, value: 43 });
    });

    it("is indeterminate before the first byte", () => {
        const n = describeDownloadNotification(base, undefined);
        expect(n.text).toBe("Starting…");
        expect(n.progress).toEqual({ max: 100, value: 0, indeterminate: true });
    });

    it("has no bar while waiting, and states the policy so the shade explains itself", () => {
        const n = describeDownloadNotification({ ...base, phase: "waiting-for-wifi" }, undefined);
        expect(n.title).toBe("Waiting for Wi-Fi · 12 queued");
        expect(n.text).toBe(WIFI_ONLY_NOTE);
        expect(n.progress).toBeUndefined();
    });
});

describe("retryDelayMs", () => {
    it("doubles from 2 s and caps at a minute", () => {
        expect(retryDelayMs(0)).toBe(0);
        expect(retryDelayMs(1)).toBe(2000);
        expect(retryDelayMs(2)).toBe(4000);
        expect(retryDelayMs(5)).toBe(32000);
        expect(retryDelayMs(6)).toBe(60000);
        expect(retryDelayMs(50)).toBe(60000);
    });
});
