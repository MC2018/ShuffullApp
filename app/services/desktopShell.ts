import { MediaKind } from "../tools/desktopMedia";

/**
 * The Electron preload's `window.shuffull` bridge (desktop/preload.js), typed once for every caller.
 *
 * It is absent on mobile and in a plain browser, so callers feature-detect it and simply do nothing there rather
 * than needing platform-specific files. Keep this in step with preload.js: nothing ties the two together at build
 * time, and a renamed method fails only at runtime, on desktop.
 */

export type ShortcutAction = "like" | "love" | "dislike" | "keep" | "neutral";

export interface DesktopMediaStore {
    /** Fetches `<host>/<kind>/<fileName>` into the store (songs hash-checked by main). Reports failure; doesn't reject. */
    download: (host: string, kind: MediaKind, fileName: string) => Promise<{ ok: boolean; error?: string }>;
    exists: (kind: MediaKind, fileName: string) => Promise<boolean>;
    remove: (kind: MediaKind, fileName: string) => Promise<void>;
    onProgress: (callback: (progress: { kind: MediaKind; fileName: string; received: number; total: number }) => void) => () => void;
}

/**
 * The prefetch cache's store (ShuffullApp#137): the same kinds and file names as `DesktopMediaStore`, kept in a
 * separate folder and served under `/__prefetch/`, so nothing in it is ever a download.
 */
export interface DesktopPrefetchStore {
    /** Fetches `<host>/<kind>/<fileName>` (songs hash-checked by main). Reports failure, cancellation included. */
    download: (host: string, kind: MediaKind, fileName: string) => Promise<{ ok: true; bytes: number } | { ok: false; error: string }>;
    /** Aborts that fetch if it is in flight; its `download` then resolves `ok: false`. */
    cancel: (kind: MediaKind, fileName: string) => Promise<void>;
    exists: (kind: MediaKind, fileName: string) => Promise<boolean>;
    remove: (kind: MediaKind, fileName: string) => Promise<void>;
    clear: () => Promise<void>;
}

export interface DesktopShell {
    onRatingShortcut: (callback: (action: ShortcutAction) => void) => () => void;
    notify: (title: string, body: string) => void;
    media: DesktopMediaStore;
    /** Absent in a desktop shell built before ShuffullApp#137; the prefetcher then reports itself unsupported. */
    prefetch?: DesktopPrefetchStore;
}

declare global {
    interface Window {
        shuffull?: DesktopShell;
    }
}

/** The bridge, or undefined anywhere but the desktop app (including `expo export`'s prerender, which has no window). */
export function desktopShell(): DesktopShell | undefined {
    return typeof window === "undefined" ? undefined : window.shuffull;
}
