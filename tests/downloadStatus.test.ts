import { describe, it, expect } from "vitest";
import {
    derivePhase,
    describeDownloadStatus,
    describeDownloadsRow,
    isDownloadNetwork,
    DownloadStatus,
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
    return { phase: "idle", queuedCount: 0, completedCount: 0, ...patch };
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
