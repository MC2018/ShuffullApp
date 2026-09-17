/**
 * What a FAILED TRACK LOAD means, and what to do about it.
 *
 * The player's error handler used to answer this with one unconditional `skip()`, on the reasoning that a
 * track which will not load is a track worth stepping over. That is right for exactly one of the three things
 * that raise the event, and it is not the common one:
 *
 *   - the SOURCE is bad (deleted server-side, corrupt file, unsupported container) — skipping is correct;
 *   - the PATH to the source is bad (timeout, dropped connection, tunnel flapping) — skipping is harmful;
 *   - something else — unknown.
 *
 * Skipping a good song because the network blinked is not merely annoying. `startNewSong` stamps
 * `user_songs.last_played` and queues an `UpdateSongLastPlayed` to the server the moment a track is handed to
 * the player, so a burned song is recorded as PLAYED — on every device, permanently. The shuffle pool is
 * `ORDER BY us.last_played ASC` and drawn from the FRONT, so a burned song drops to the back of the rotation;
 * an audition pool narrows to `last_played IS NULL OR <= 0` outright, so a burned audition song leaves the
 * cohort entirely and renders "heard" — dimmed, and gone when the mix is purged. The user never heard a note
 * of it. Worse, each skip loads the next track over the same dead path, so ONE blip burns songs in a row
 * until the consecutive-skip bound stops it.
 *
 * The two mistakes are therefore not symmetric, and the default must not pretend they are:
 *
 *   a wrong RETRY costs a few seconds of silence, and is fully recoverable;
 *   a wrong SKIP costs a song out of the rotation, and is written to the server.
 *
 * Everything below follows from that asymmetry. An unknown failure retries FIRST and only skips once retrying
 * has visibly not helped, and a transient failure never skips at all, however long it lasts.
 *
 * Pure, and free of react-native-track-player, so this is unit-testable — mediaManager is not.
 */

export type PlaybackFailureKind = "transient" | "permanent" | "unknown";

/** The shape every platform's error event narrows to. Both fields are absent on some of them. */
export interface PlaybackErrorLike {
    code?: string | null;
    message?: string | null;
}

/**
 * Codes meaning "the bytes never arrived", never "the bytes are wrong".
 *
 * The Android spellings are not invented: the RNTP fork takes media3's `PlaybackException.errorCodeName`,
 * strips `ERROR_CODE_`, lowercases it, turns `_` into `-` and prefixes `android-`
 * (AudioPlayer.kt `onPlayerError` + MusicService.kt `getPlaybackErrorBundle`). The iOS spellings come from
 * `getPlaybackStateErrorKeyValues` in RNTrackPlayer.swift, which uses underscores and no platform prefix.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
    "android-io-network-connection-failed",
    "android-io-network-connection-timeout",
    "android-io-unspecified", // media3's bucket for IOExceptions it has no more specific code for
    "android-timeout",
    "android-remote-error",
    "android-behind-live-window",
    "ios_not_connected_to_internet",
    "ios_failed_to_load_resource",
    "web-network",
]);

/** Codes meaning the source itself is unusable, so waiting cannot help. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
    "android-io-file-not-found",
    "android-io-no-permission",
    "android-io-cleartext-not-permitted",
    "android-io-invalid-http-content-type",
    "android-io-read-position-out-of-range",
    "ios_invalid_source_url",
    "ios_track_unplayable",
    "web-decode",
]);

/** Whole media3 families that are about the CONTENT: parsing, decoding, output, DRM. */
const PERMANENT_PREFIXES: readonly string[] = [
    "android-parsing-",
    "android-decoder-",
    "android-decoding-",
    "android-audio-track-",
    "android-drm-",
];

/** HTTP statuses below 500 that still mean "ask again later" rather than "this will never work". */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

export function isRetryableHttpStatus(status: number): boolean {
    return status >= 500 || RETRYABLE_HTTP_STATUSES.has(status);
}

/**
 * `android-io-bad-http-status` covers both halves of the split on its own: a 404 from a song deleted
 * server-side and a 502 from the Cloudflare tunnel restarting arrive under the identical code. media3 puts the
 * number in the message (`InvalidResponseCodeException` is constructed as `"Response code: " + code`), so the
 * message is the only place the distinction exists.
 */
function extractHttpStatus(message: string | null | undefined): number | undefined {
    const match = /response code:\s*(\d{3})/i.exec(message ?? "");
    return match ? Number(match[1]) : undefined;
}

export interface ClassifyOptions {
    /**
     * Whether the track was loaded off local storage rather than streamed.
     *
     * The strongest signal available, and worth more than any code: a file already on disk cannot fail
     * because the network did, so nothing about a local failure is worth waiting out. Retrying one would
     * stall playback on a song that will never load, which is the failure mode the skip existed to prevent.
     */
    isLocalSource?: boolean;
}

export function classifyPlaybackError(
    error: PlaybackErrorLike | null | undefined,
    { isLocalSource = false }: ClassifyOptions = {},
): PlaybackFailureKind {
    if (isLocalSource) {
        return "permanent";
    }

    const code = (error?.code ?? "").trim().toLowerCase();
    const message = error?.message ?? undefined;

    if (code === "android-io-bad-http-status") {
        const status = extractHttpStatus(message);
        // An unreadable message leaves the status unknown, and "unknown" is the branch that retries before it
        // skips — which is the side to be wrong on.
        if (status == undefined) {
            return "unknown";
        }
        return isRetryableHttpStatus(status) ? "transient" : "permanent";
    }

    if (TRANSIENT_CODES.has(code)) {
        return "transient";
    }

    if (PERMANENT_CODES.has(code) || PERMANENT_PREFIXES.some(prefix => code.startsWith(prefix))) {
        return "permanent";
    }

    return "unknown";
}

/**
 * Delay before each successive retry of the same track, in attempts already made. Front-loaded because most
 * blips are over in a couple of seconds, then flattening out so a long outage is not a busy-loop on the radio.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

/** Retries of one track for a transient fault before the player gives up waiting and says so. */
export const MAX_TRANSIENT_ATTEMPTS = 8;

/**
 * Retries of one track for an UNCLASSIFIED fault before it is treated as a bad source and skipped. Small on
 * purpose: this is the budget spent proving that an unrecognised error is not just the network, and two
 * attempts is enough to rule that out without leaving playback stalled on a genuinely dead song.
 */
export const MAX_UNKNOWN_ATTEMPTS = 2;

/**
 * Songs skipped in a row for being unplayable before the player stops rather than carrying on. Without a
 * bound, a batch deleted server-side (or a device with nothing downloaded) would let skip-on-error tear
 * through the whole library. Anything that actually plays clears the count.
 */
export const MAX_CONSECUTIVE_SKIPS = 5;

export type PlaybackRecovery =
    | { action: "retry"; delayMs: number }
    | { action: "skip" }
    | { action: "halt"; reason: "offline" | "unplayable-run" };

export interface RecoveryInput {
    kind: PlaybackFailureKind;
    /** Failed attempts already made at THIS track since it last played. */
    attempt: number;
    /** Songs skipped in a row because they failed to load. */
    consecutiveSkips: number;
}

export function retryDelayMs(attempt: number): number {
    const index = Math.min(Math.max(attempt, 0), RETRY_BACKOFF_MS.length - 1);
    return RETRY_BACKOFF_MS[index];
}

export function decidePlaybackRecovery({ kind, attempt, consecutiveSkips }: RecoveryInput): PlaybackRecovery {
    if (kind === "transient") {
        // Never a skip, at any attempt count. Advancing the queue cannot help when the fault is the path to
        // the bytes, and it is exactly what turns one blip into several songs marked played-but-unheard.
        // Exhausting the budget stops the timer, not the recovery: the caller still resumes this same track
        // when connectivity returns.
        return attempt < MAX_TRANSIENT_ATTEMPTS
            ? { action: "retry", delayMs: retryDelayMs(attempt) }
            : { action: "halt", reason: "offline" };
    }

    if (kind === "unknown" && attempt < MAX_UNKNOWN_ATTEMPTS) {
        return { action: "retry", delayMs: retryDelayMs(attempt) };
    }

    // Permanent, or unknown that has run out of benefit of the doubt: this song is the problem, so step over
    // it — bounded, so a bad stretch of the library cannot run away.
    return consecutiveSkips >= MAX_CONSECUTIVE_SKIPS
        ? { action: "halt", reason: "unplayable-run" }
        : { action: "skip" };
}
