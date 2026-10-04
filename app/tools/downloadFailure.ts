// What a finished download attempt means for its queue row. Pure (no expo-file-system), so it is
// unit-testable — Downloader.ts throws at module scope off-device. See tests/downloadFailure.test.ts.
//
// The bug this exists for (ShuffullApp#86): `downloadAsync` does NOT throw on an HTTP error. A 404 for a song
// purged server-side writes the empty body to the temp file, the hash check fails, and the row used to stay at
// the head of the queue — so the same dead song was retried forever and nothing behind it ever downloaded.
//
// The split mirrors playbackFailure.ts, but the asymmetry is milder here: a wrong DROP only loses a queue row
// (the song is still in the library and can be queued again), while a wrong RETRY wedges every song behind it.
// So a status that will never change is dropped at once, and only "the server or the path is having a moment"
// stays — and that one must stay, or a tunnel outage (530) would empty a 4,000-song queue in a minute.
import { isRetryableHttpStatus } from "./playbackFailure";

/**
 * A 2xx whose bytes don't hash to the song's fileHash is ambiguous: a truncated transfer looks the same as a
 * server file that will never match (corrupt, or replaced under a stale local record). Retry a few times, then
 * stop letting it block the queue.
 */
export const MAX_HASH_MISMATCHES = 3;

export type SongDownloadDecision =
    | { action: "accept" }
    /** Leave the row where it is; the drain loop backs off before the next attempt. */
    | { action: "retry"; reason: string }
    /** Remove the row without marking the song downloaded. */
    | { action: "drop"; reason: string };

/**
 * @param result      what `downloadAsync` returned (undefined when it was cancelled/interrupted). `hashMatches`
 *                    is only consulted for a non-error status, so callers may skip hashing an error body.
 * @param mismatchesSoFar hash mismatches already seen for this song, NOT counting this attempt.
 */
export function decideSongDownload(
    result: { status: number; hashMatches?: boolean } | undefined,
    mismatchesSoFar: number,
): SongDownloadDecision {
    if (result == undefined) {
        return { action: "retry", reason: "download returned no result" };
    }

    if (result.status >= 400) {
        return isRetryableHttpStatus(result.status)
            ? { action: "retry", reason: `server returned ${result.status}` }
            : { action: "drop", reason: `server returned ${result.status}` };
    }

    if (result.hashMatches !== true) {
        const mismatches = mismatchesSoFar + 1;
        return mismatches >= MAX_HASH_MISMATCHES
            ? { action: "drop", reason: `file hash did not match after ${mismatches} attempts` }
            : { action: "retry", reason: `file hash did not match (attempt ${mismatches} of ${MAX_HASH_MISMATCHES})` };
    }

    return { action: "accept" };
}

/**
 * Album art is best-effort: the song plays without it, and every art lookup already falls back to the server URL
 * when there is no local file. Only a 2xx body is worth keeping — anything else is an error page saved as `.jpg`.
 */
export function isUsableArtDownload(result: { status: number } | undefined): boolean {
    return result != undefined && result.status >= 200 && result.status < 300;
}
