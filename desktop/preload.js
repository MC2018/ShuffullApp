const { contextBridge, ipcRenderer } = require("electron");

/**
 * The only bridge between the Electron main process and the app.
 *
 * The window runs with contextIsolation on and nodeIntegration off, so the renderer has no access to Node or
 * to ipcRenderer directly. This exposes four things and nothing else: a subscription to the global rating
 * shortcuts, a way to raise a desktop notification, the offline media store and the prefetch cache. Anything
 * wider would hand the whole page (which loads remote album art) a route into the main process. The media and
 * prefetch calls take a kind, a file name and the API host - never a path or a full URL. Main validates the kind
 * and name, accepts only an http(s) host, and builds the URL itself as `<host>/<kind>/<file>` (desktop/media.js).
 *
 * `window.shuffull` is absent on mobile and in a plain browser, so the app can feature-detect it and simply do
 * nothing there rather than needing platform-specific files.
 */
contextBridge.exposeInMainWorld("shuffull", {
    /**
     * Called when the user presses one of the global rating shortcuts. `action` is one of
     * "like" | "love" | "dislike" | "keep" | "neutral". Returns an unsubscribe function.
     */
    onRatingShortcut: (callback) => {
        const listener = (_event, action) => callback(action);
        ipcRenderer.on("shuffull:rating-shortcut", listener);
        return () => ipcRenderer.removeListener("shuffull:rating-shortcut", listener);
    },

    /**
     * Raises a desktop notification. The shortcuts are global, so the user is usually looking at another
     * window when one fires - without this there is no feedback at all that anything happened, and a rating
     * that silently did nothing is worse than no shortcut.
     */
    notify: (title, body) => ipcRenderer.send("shuffull:notify", { title, body }),

    /**
     * Offline songs and album art, for the web Downloader. `kind` is "music" | "albumart"; `fileName` is
     * `<fileHash><ext>`. Stored files are served at `/__media/<kind>/<fileName>` on the page's own origin.
     */
    media: {
        /** Fetches `<host>/<kind>/<fileName>` into the store. Resolves `{ ok }` or `{ ok: false, error }`. */
        download: (host, kind, fileName) => ipcRenderer.invoke("shuffull:media:download", { host, kind, fileName }),
        exists: (kind, fileName) => ipcRenderer.invoke("shuffull:media:exists", { kind, fileName }),
        remove: (kind, fileName) => ipcRenderer.invoke("shuffull:media:delete", { kind, fileName }),
        /** `callback({ kind, fileName, received, total })` as a download progresses. Returns an unsubscribe function. */
        onProgress: (callback) => {
            const listener = (_event, progress) => callback(progress);
            ipcRenderer.on("shuffull:media:progress", listener);
            return () => ipcRenderer.removeListener("shuffull:media:progress", listener);
        },
    },

    /**
     * The prefetch cache ("Load upcoming songs ahead"), for the web Prefetcher. Same kinds and file names as `media`,
     * but a separate store served at `/__prefetch/<kind>/<fileName>`, so nothing in it is ever a download.
     */
    prefetch: {
        /** Resolves `{ ok: true, bytes }` or `{ ok: false, error }`. Songs are hash-checked by main. */
        download: (host, kind, fileName) => ipcRenderer.invoke("shuffull:prefetch:download", { host, kind, fileName }),
        cancel: (kind, fileName) => ipcRenderer.invoke("shuffull:prefetch:cancel", { kind, fileName }),
        exists: (kind, fileName) => ipcRenderer.invoke("shuffull:prefetch:exists", { kind, fileName }),
        remove: (kind, fileName) => ipcRenderer.invoke("shuffull:prefetch:delete", { kind, fileName }),
        clear: () => ipcRenderer.invoke("shuffull:prefetch:clear"),
    },
});
