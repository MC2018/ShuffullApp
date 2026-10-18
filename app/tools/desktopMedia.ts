// Pure helpers for the desktop shell's offline media store (desktop/media.js). No React Native imports, so
// they are unit-tested (tests/desktopMedia.test.ts) and shared by every web-build caller of the Downloader.

/** Route the Electron `app://` handler serves stored files under. Must match `MEDIA_ROUTE` in desktop/media.js. */
export const MEDIA_ROUTE = "/__media/";

export type MediaKind = "music" | "albumart";

/** Where a stored file is played/shown from: the page's own origin, so it is same-origin under COEP. */
export function localMediaUri(origin: string, kind: MediaKind, fileName: string): string {
    return `${origin}${MEDIA_ROUTE}${kind}/${fileName}`;
}

/**
 * The inverse of `localMediaUri`, for `Downloader.fileExists(uri)`, whose callers hand back a URI rather than a
 * song. Anything that isn't one of ours (a server URL, the empty string the browser build returns) is undefined,
 * which `fileExists` answers as "not stored".
 */
export function parseLocalMediaUri(uri: string): { kind: MediaKind; fileName: string } | undefined {
    let pathname: string;
    try {
        pathname = new URL(uri, "app://local").pathname;
    } catch {
        return undefined;
    }
    if (!pathname.startsWith(MEDIA_ROUTE)) {
        return undefined;
    }
    const [kind, fileName, ...rest] = pathname.slice(MEDIA_ROUTE.length).split("/");
    if (rest.length > 0 || (kind !== "music" && kind !== "albumart") || !fileName) {
        return undefined;
    }
    return { kind, fileName };
}
