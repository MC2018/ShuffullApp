import { beforeEach, describe, expect, it, vi } from "vitest";
import { Song } from "@/app/services/db/models";
import type { DesktopPrefetchStore } from "@/app/services/desktopShell";
import type { MediaKind } from "@/app/tools/desktopMedia";

/**
 * The desktop's adapter between `StorePrefetcher` and the shell's prefetch store (ShuffullApp#137). It decides
 * what reaches the shell and what URIs come back: a song with no art is still cached, a failed song costs no art
 * fetch, and every URI is on the prefetch route, never the Downloads one.
 */

const storage = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
    default: { getItem: async (key: string) => storage.get(key) ?? null },
}));
// Vitest resolves the native Downloader, not the web one; only its file naming is used here.
vi.mock("@/app/services/downloader/Downloader", () => ({
    Downloader: {
        generateSongFileName: (song: Song) => `${song.fileHash}${song.fileExtension}`,
        generateAlbumArtFileName: (song: Song) => `${song.fileHash}.jpg`,
        generateLocalSongUri: (song: Song) => `downloads/${song.fileHash}`,
        fileExists: async (uri: string) => uri === "downloads/kept",
    },
}));

const { desktopPrefetchStore } = await import("@/app/services/prefetch/Prefetcher.web");
const { STORAGE_KEYS } = await import("@/app/constants/storageKeys");

function song(fileHash: string): Song {
    return {
        songId: `id-${fileHash}`, fileExtension: ".mp3", fileHash, name: fileHash,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, heaviness: null, exploratory: false, tagsStale: false, hookStartPercent: null,
    };
}

const live = () => new AbortController().signal;

type Result = { ok: true; bytes: number } | { ok: false; error: string };

class FakeBridge implements DesktopPrefetchStore {
    calls: string[] = [];
    results = new Map<string, Result>();
    /** Runs as a download starts, before it returns. */
    onDownload: (kind: MediaKind) => void = () => undefined;

    async download(host: string, kind: MediaKind, fileName: string): Promise<Result> {
        this.calls.push(`download ${host} ${kind}/${fileName}`);
        this.onDownload(kind);
        return this.results.get(`${kind}/${fileName}`) ?? { ok: true, bytes: 42 };
    }
    async cancel(kind: MediaKind, fileName: string) {
        this.calls.push(`cancel ${kind}/${fileName}`);
    }
    async exists(kind: MediaKind, fileName: string) {
        this.calls.push(`exists ${kind}/${fileName}`);
        return true;
    }
    async remove(kind: MediaKind, fileName: string) {
        this.calls.push(`remove ${kind}/${fileName}`);
    }
    async clear() {
        this.calls.push("clear");
    }
}

let bridge: FakeBridge;

beforeEach(() => {
    storage.clear();
    storage.set(STORAGE_KEYS.HOST_ADDRESS, "http://api.test");
    bridge = new FakeBridge();
});

describe("desktopPrefetchStore", () => {
    it("fetches the song then its art, and hands back prefetch-route URIs", async () => {
        const result = await desktopPrefetchStore(bridge).fetch(song("abc"), live());

        expect(bridge.calls).toEqual(["download http://api.test music/abc.mp3", "download http://api.test albumart/abc.jpg"]);
        expect(result).toEqual({ bytes: 42, audioUri: "/__prefetch/music/abc.mp3", artUri: "/__prefetch/albumart/abc.jpg" });
    });

    it("still caches a song the server has no art for", async () => {
        bridge.results.set("albumart/abc.jpg", { ok: false, error: "HTTP 404 for albumart/abc.jpg" });

        expect(await desktopPrefetchStore(bridge).fetch(song("abc"), live())).toEqual({ bytes: 42, audioUri: "/__prefetch/music/abc.mp3", artUri: undefined });
    });

    it("doesn't fetch art for a song that failed its hash check", async () => {
        bridge.results.set("music/abc.mp3", { ok: false, error: "integrity check failed for music/abc.mp3" });

        expect(await desktopPrefetchStore(bridge).fetch(song("abc"), live())).toEqual({ error: "integrity check failed for music/abc.mp3" });
        expect(bridge.calls).toEqual(["download http://api.test music/abc.mp3"]);
    });

    it("fetches nothing without a host", async () => {
        storage.clear();
        const store = desktopPrefetchStore(bridge);

        expect(await store.canFetch()).toBe(false);
        expect(await store.fetch(song("abc"), live())).toEqual({ error: "no host" });
        expect(bridge.calls).toEqual([]);
    });

    it("checks and removes both of a song's files by name", async () => {
        const store = desktopPrefetchStore(bridge);
        await store.exists(song("abc"));
        await store.remove(song("abc"));

        expect(bridge.calls).toEqual(["exists music/abc.mp3", "remove music/abc.mp3", "remove albumart/abc.jpg"]);
    });

    it("starts no download once aborted, even while it is still reading the host", async () => {
        const abort = new AbortController();
        const fetching = desktopPrefetchStore(bridge).fetch(song("abc"), abort.signal);
        abort.abort();

        expect(await fetching).toEqual({ error: "cancelled" });
        expect(bridge.calls).toEqual([]);
    });

    it("cancels the shell's download by name, and throws out audio that landed anyway", async () => {
        const abort = new AbortController();
        bridge.onDownload = () => abort.abort();

        expect(await desktopPrefetchStore(bridge).fetch(song("abc"), abort.signal)).toEqual({ error: "cancelled" });
        expect(bridge.calls).toEqual([
            "download http://api.test music/abc.mp3",
            "cancel music/abc.mp3",
            "cancel albumart/abc.jpg",
            "remove music/abc.mp3",
        ]);
    });

    it("asks Downloads whether the song is already there", async () => {
        const store = desktopPrefetchStore(bridge);

        expect(await store.isDownloaded(song("kept"))).toBe(true);
        expect(await store.isDownloaded(song("abc"))).toBe(false);
    });
});
