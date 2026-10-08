// What a finished download attempt means for its queue row. Pure (no expo-file-system), so it is
// unit-testable — Downloader.ts throws at module scope off-device. See tests/downloadFailure.test.ts.
//
// The bug this exists for (ShuffullApp#86): `downloadAsync` does NOT throw on an HTTP error. A 404 for a song
// purged server-side writes the empty body to the temp file, the hash check fails, and the row used to stay at
// the head of the queue — so the same dead song was retried forever and nothing behind it ever downloaded.
//
// The split mirrors playbackFailure.ts. A status that will never change drops the row; "the server or the path
// is having a moment" (5xx, the tunnel's 530) keeps it, with no limit, or an outage would empty the queue.
//
// A drop is only safe one song at a time. Some failures answer EVERY song with the same 404/403 — the API's
// music volume not mounted (it starts anyway and serves an empty folder), or a Cloudflare rule in front of the
// tunnel — and queue rows exist only on the device, so dropping on those would delete the whole queue. Hence
// MAX_CONSECUTIVE_DROPS, the counterpart of playbackFailure's MAX_CONSECUTIVE_SKIPS.
import { isRetryableHttpStatus } from "./playbackFailure";

/**
 * A 2xx whose bytes don't hash to the song's fileHash is ambiguous: a truncated transfer looks the same as a
 * server file that will never match (corrupt, or replaced under a stale local record). Retry a few times, then
 * stop letting it block the queue.
 */
export const MAX_HASH_MISMATCHES = 3;

/**
 * Drops allowed in a row with no successful download between them. Past this the failure is more likely the
 * server than the songs, so further rows are deferred (kept, sent to the back of the queue) instead of dropped.
 * A run of genuinely dead songs still drains: the next song that downloads resets the count, and the deferred
 * ones are dropped when they come round again.
 */
export const MAX_CONSECUTIVE_DROPS = 5;

export interface SongDownloadHistory {
    /** Hash mismatches already seen for this song, NOT counting this attempt. */
    hashMismatches: number;
    /** Rows dropped since the last successful download, across all songs. */
    consecutiveDrops: number;
}

export type SongDownloadDecision =
    | { action: "accept" }
    /** Leave the row where it is; the drain loop backs off before the next attempt. `hashMismatches` is this
     *  song's updated count, for the caller to store. */
    | { action: "retry"; reason: string; hashMismatches: number }
    /** Would have been dropped, but too many drops in a row: keep the row, move it to the back, back off. */
    | { action: "defer"; reason: string }
    /** Remove the row without marking the song downloaded. */
    | { action: "drop"; reason: string };

/**
 * @param result what `downloadAsync` returned (undefined when it was cancelled/interrupted). `hashMatches` is only
 *               consulted for a non-error status, so callers may skip hashing an error body.
 */
export function decideSongDownload(
    result: { status: number; hashMatches?: boolean } | undefined,
    history: SongDownloadHistory,
): SongDownloadDecision {
    if (result == undefined) {
        return { action: "retry", reason: "download returned no result", hashMismatches: history.hashMismatches };
    }

    if (result.status >= 400) {
        return isRetryableHttpStatus(result.status)
            ? { action: "retry", reason: `server returned ${result.status}`, hashMismatches: history.hashMismatches }
            : dropUnlessOnARun(`server returned ${result.status}`, history);
    }

    if (result.hashMatches !== true) {
        const mismatches = history.hashMismatches + 1;
        return mismatches >= MAX_HASH_MISMATCHES
            ? dropUnlessOnARun(`file hash did not match after ${mismatches} attempts`, history)
            : {
                action: "retry",
                reason: `file hash did not match (attempt ${mismatches} of ${MAX_HASH_MISMATCHES})`,
                hashMismatches: mismatches,
            };
    }

    return { action: "accept" };
}

function dropUnlessOnARun(reason: string, history: SongDownloadHistory): SongDownloadDecision {
    if (history.consecutiveDrops >= MAX_CONSECUTIVE_DROPS) {
        return {
            action: "defer",
            reason: `${reason}, but ${history.consecutiveDrops} songs in a row have already been dropped with no download in between, so keeping it`,
        };
    }
    return { action: "drop", reason };
}

/**
 * Album art doesn't block a song the server says has none (a permanent 4xx): the song plays without it. Anything
 * that may clear up — interrupted, 5xx, the tunnel's 530 — retries the whole song, because nothing fetches art
 * after the fact and the server-URL fallback only works online, which is not when a downloaded song is played.
 *   keep    – a 2xx; move it into place
 *   without – the server has no art for this song; save the song without it
 *   retry   – leave the row and back off, as for the audio
 */
export type ArtDownloadDecision = "keep" | "without" | "retry";

export function decideArtDownload(result: { status: number } | undefined): ArtDownloadDecision {
    if (result == undefined) {
        return "retry";
    }
    if (result.status >= 200 && result.status < 300) {
        return "keep";
    }
    if (result.status >= 400 && !isRetryableHttpStatus(result.status)) {
        return "without";
    }
    return "retry";
}
