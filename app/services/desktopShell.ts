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
    /** Fetches `<host>/<kind>/<fileName>` into the store. Never rejects for a failed download; reports it. */
    download: (host: string, kind: MediaKind, fileName: string, verify: boolean) => Promise<{ ok: boolean; error?: string }>;
    exists: (kind: MediaKind, fileName: string) => Promise<boolean>;
    remove: (kind: MediaKind, fileName: string) => Promise<void>;
    onProgress: (callback: (progress: { kind: MediaKind; fileName: string; received: number; total: number }) => void) => () => void;
}

export interface DesktopShell {
    onRatingShortcut: (callback: (action: ShortcutAction) => void) => () => void;
    notify: (title: string, body: string) => void;
    media: DesktopMediaStore;
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
