const { contextBridge, ipcRenderer } = require("electron");

/**
 * The only bridge between the Electron main process and the app.
 *
 * The window runs with contextIsolation on and nodeIntegration off, so the renderer has no access to Node or
 * to ipcRenderer directly. This exposes exactly two things and nothing else: a subscription to the global
 * rating shortcuts, and a way to raise a desktop notification. Anything wider would hand the whole page
 * (which loads remote album art) a route into the main process.
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
});
