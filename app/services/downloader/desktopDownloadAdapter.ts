import { DesktopMediaStore, isOnline } from "../desktopShell";
import { DownloadAdapter, DownloadResult } from "./DownloadQueueRunner";
import { listStoredSongFiles } from "./reconcileDownloads";

/**
 * The Electron desktop's side of the download loop: the shell's media store (`window.shuffull.media`, kept on disk
 * by desktop/media.js), and "online" as the only network gate. What differs from native:
 *
 * - **Online is enough.** The phone's Wi-Fi allowlist protects a data plan; a desktop has none, and the web network
 *   API can't tell Wi-Fi from Ethernet, so the allowlist would wait for Wi-Fi forever. `wifiOnly: false` makes the
 *   status and the Downloads screen say so.
 * - **No background hold.** The Electron window keeps the renderer alive; there is nothing to hold.
 * - **Main verifies, not the page.** media.js hash-checks every song before moving it into place, so `verify` is
 *   decided there and ignored here.
 */
export function createDesktopDownloadAdapter(media: DesktopMediaStore): DownloadAdapter {
    // Progress arrives on one channel for every download; route it to the fetch that asked.
    const progress = new Map<string, (fraction: number) => void>();
    media.onProgress(({ kind, fileName, received, total }) => {
        if (total > 0) {
            progress.get(`${kind}/${fileName}`)?.(received / total);
        }
    });

    return {
        wifiOnly: false,
        exists: (kind, fileName) => media.exists(kind, fileName),
        async download(host, kind, fileName, _verify, onProgress) {
            const key = `${kind}/${fileName}`;
            progress.set(key, onProgress);
            try {
                return desktopDownloadResult(await media.download(host, kind, fileName));
            } finally {
                progress.delete(key);
            }
        },
        canDownloadNow: async () => isOnline(),
        network: async () => ({ isInternetReachable: isOnline(), type: undefined }),
        listSongFiles: (songFileNames) => listStoredSongFiles(media, songFileNames),
        watch(onChange) {
            // "Offline" the moment the connection drops, and the queue picks back up the moment it returns.
            window.addEventListener("online", onChange);
            window.addEventListener("offline", onChange);
        },
    };
}

/**
 * The store's answer in the shape the loop's failure rules read (tools/downloadFailure.ts), so a song the server no
 * longer has is dropped on desktop too instead of wedging the queue (ShuffullApp#86). A failure that says neither
 * which HTTP status nor that the hash failed (a network error, a refused name) reads as "no result": retried.
 */
export function desktopDownloadResult(result: Awaited<ReturnType<DesktopMediaStore["download"]>>): DownloadResult {
    if (result.ok) {
        return { status: 200, hashMatches: true };
    }
    if (result.hashMismatch) {
        return { status: 200, hashMatches: false };
    }
    if (result.status != undefined) {
        return { status: result.status };
    }
    return undefined;
}
