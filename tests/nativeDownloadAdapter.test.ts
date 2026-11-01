import { beforeEach, describe, expect, it, vi } from "vitest";

// The native adapter's file handling, with expo-file-system replaced by a record of what was asked of it. The
// runner's tests use a fake adapter, so this is what checks that a failed fetch never lands in the store.

const fs = vi.hoisted(() => ({
    status: 200 as number | undefined,
    moves: [] as { from: string; to: string }[],
    deletes: [] as string[],
    fetches: [] as { url: string; to: string }[],
}));
const hashMatches = vi.hoisted(() => ({ value: true, checked: [] as string[] }));

vi.mock("expo-file-system/legacy", () => ({
    documentDirectory: "file:///docs/",
    createDownloadResumable: (url: string, to: string, _options: unknown, onProgress: (p: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void) => ({
        downloadAsync: async () => {
            fs.fetches.push({ url, to });
            onProgress({ totalBytesWritten: 1, totalBytesExpectedToWrite: 4 });
            return fs.status == undefined ? undefined : { status: fs.status, uri: to };
        },
    }),
    moveAsync: async (move: { from: string; to: string }) => { fs.moves.push(move); },
    deleteAsync: async (uri: string) => { fs.deletes.push(uri); },
    getInfoAsync: async () => ({ exists: false }),
    makeDirectoryAsync: async () => {},
    readDirectoryAsync: async () => [],
}));
vi.mock("expo-network", () => ({
    getNetworkStateAsync: async () => ({ isInternetReachable: true, type: "WIFI" }),
    addNetworkStateListener: () => {},
}));
vi.mock("react-native", () => ({ AppState: { addEventListener: () => {} } }));
vi.mock("@/app/services/background/foregroundService", () => ({ foregroundService: {} }));
vi.mock("@/app/services/background/notificationPermission", () => ({ ensureNotificationPermission: async () => true }));
vi.mock("@/app/tools/utils", () => ({
    verifyFileIntegrity: async (uri: string) => {
        hashMatches.checked.push(uri);
        return hashMatches.value;
    },
}));

const { createNativeDownloadAdapter } = await import("@/app/services/downloader/nativeDownloadAdapter");

const TEMP = "file:/docs/temp/hash.mp3";

describe("native download adapter", () => {
    const adapter = createNativeDownloadAdapter();

    beforeEach(() => {
        fs.status = 200;
        fs.moves = [];
        fs.deletes = [];
        fs.fetches = [];
        hashMatches.value = true;
        hashMatches.checked = [];
    });

    it("moves a verified song into the music folder and reports progress", async () => {
        const progress: number[] = [];

        const result = await adapter.download("https://api.test", "music", "hash.mp3", true, (f) => progress.push(f));

        expect(result).toEqual({ status: 200, hashMatches: true });
        expect(fs.fetches).toEqual([{ url: "https:/api.test/music/hash.mp3", to: TEMP }]);
        expect(hashMatches.checked).toEqual([TEMP]);
        expect(fs.moves).toEqual([{ from: TEMP, to: "file:/docs/music/hash.mp3" }]);
        expect(progress).toEqual([0.25]);
        expect(fs.deletes).toEqual([TEMP]);
    });

    it("leaves a song whose hash doesn't match out of the store", async () => {
        hashMatches.value = false;

        const result = await adapter.download("https://api.test", "music", "hash.mp3", true, () => {});

        expect(result).toEqual({ status: 200, hashMatches: false });
        expect(fs.moves).toEqual([]);
        expect(fs.deletes).toEqual([TEMP]);
    });

    it.each([404, 503, 302])("never hashes or moves a %i body, and deletes it", async (status) => {
        fs.status = status;

        const result = await adapter.download("https://api.test", "music", "hash.mp3", true, () => {});

        expect(result).toEqual({ status });
        expect(hashMatches.checked).toEqual([]);
        expect(fs.moves).toEqual([]);
        expect(fs.deletes).toEqual([TEMP]);
    });

    it("reports an interrupted download as no result and cleans up", async () => {
        fs.status = undefined;

        expect(await adapter.download("https://api.test", "music", "hash.mp3", true, () => {})).toBeUndefined();
        expect(fs.moves).toEqual([]);
        expect(fs.deletes).toEqual([TEMP]);
    });

    it("moves album art in on a 2xx without hashing it, and not on an error", async () => {
        const temp = "file:/docs/temp/hash.jpg";

        expect(await adapter.download("https://api.test", "albumart", "hash.jpg", false, () => {})).toEqual({ status: 200, hashMatches: undefined });
        expect(fs.moves).toEqual([{ from: temp, to: "file:/docs/albumart/hash.jpg" }]);

        fs.moves = [];
        fs.status = 404;
        expect(await adapter.download("https://api.test", "albumart", "hash.jpg", false, () => {})).toEqual({ status: 404 });
        expect(fs.moves).toEqual([]);
        expect(hashMatches.checked).toEqual([]);
    });
});
