import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { Song } from "../db/models";
import { Downloader } from "../downloader/Downloader";
import { desktopShell, DesktopPrefetchStore, isOnline, pageOrigin } from "../desktopShell";
import { prefetchMediaUri } from "../../tools/desktopMedia";
import { PrefetchStore, StorePrefetcher } from "./StorePrefetcher";
import { Prefetcher } from "./types";

/**
 * Web build of the prefetch cache (ShuffullApp#137). Two hosts, as with the web Downloader:
 *
 * - **The Electron desktop app.** The shell's preload exposes `window.shuffull.prefetch`, a store the main process
 *   keeps on disk next to (never inside) the Downloads store (desktop/media.js). Main fetches each song, checks its
 *   hash the same way it checks a download, and serves it back under `/__prefetch/` on the page's own origin, so
 *   `<audio>` plays it like a downloaded song. `StorePrefetcher` does the bookkeeping, the same code as on native.
 * - **A plain browser, or a desktop shell built before #137.** No bridge: `supported` is false, Settings says
 *   the option isn't available here, and the player picks at skip time and streams exactly as before.
 *
 * Why the shell's store and not OPFS or Cache Storage in the page: the shell already downloads, verifies and serves
 * songs with Range support (seeking) for Downloads, streaming to disk without holding a song in the page's memory.
 * Fetching from the page would also need CORS headers on `/music`, and the API serves its static files before its
 * CORS middleware runs (Shuffull.Api Program.cs), so they have none.
 */

/** Exported for its tests. */
export function desktopPrefetchStore(bridge: DesktopPrefetchStore): PrefetchStore {
    const audioName = (song: Song) => Downloader.generateSongFileName(song);
    const artName = (song: Song) => Downloader.generateAlbumArtFileName(song);

    return {
        clear: () => bridge.clear(),
        // Any connection will do, as on native (decided 2026-10-27); the setting is the off switch.
        canFetch: async () => isOnline() && (await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS)) != null,
        isDownloaded: song => Downloader.fileExists(Downloader.generateLocalSongUri(song)),
        async fetch(song, signal) {
            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

            if (hostAddress == null) {
                return { error: "no host" };
            }

            // The shell aborts a download by name. IPC keeps order, so a cancel sent after a download reaches it.
            const onAbort = () => {
                void bridge.cancel("music", audioName(song)).catch(() => undefined);
                void bridge.cancel("albumart", artName(song)).catch(() => undefined);
            };
            signal.addEventListener("abort", onAbort);

            try {
                if (signal.aborted) {
                    return { error: "cancelled" };
                }

                const audio = await bridge.download(hostAddress, "music", audioName(song));

                if (!audio.ok) {
                    return { error: audio.error };
                }

                if (signal.aborted) {
                    await bridge.remove("music", audioName(song));
                    return { error: "cancelled" };
                }

                // Best-effort, as for a download: the player falls back to the server URL for art it doesn't have.
                const art = await bridge.download(hostAddress, "albumart", artName(song));
                return {
                    bytes: audio.bytes,
                    audioUri: prefetchMediaUri(pageOrigin(), "music", audioName(song)),
                    artUri: art.ok ? prefetchMediaUri(pageOrigin(), "albumart", artName(song)) : undefined,
                };
            } finally {
                signal.removeEventListener("abort", onAbort);
            }
        },
        exists: song => bridge.exists("music", audioName(song)),
        async remove(song) {
            await bridge.remove("music", audioName(song));
            await bridge.remove("albumart", artName(song));
        },
    };
}

const unsupported: Prefetcher = {
    supported: false,
    want: () => undefined,
    markPlaying: () => undefined,
    filesFor: async () => undefined,
};

const bridge = desktopShell()?.prefetch;

export const prefetcher: Prefetcher = bridge == undefined ? unsupported : new StorePrefetcher(desktopPrefetchStore(bridge));
