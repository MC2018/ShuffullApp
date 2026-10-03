import { describe, it, expect } from "vitest";
import {
    classifyPlaybackError,
    decidePlaybackRecovery,
    isRetryableHttpStatus,
    retryDelayMs,
    MAX_CONSECUTIVE_SKIPS,
    MAX_TRANSIENT_ATTEMPTS,
    MAX_UNKNOWN_ATTEMPTS,
    RETRY_BACKOFF_MS,
} from "@/app/tools/playbackFailure";

// The regression these guard: a brief loss of connection made the player skip song after song, because every
// PlaybackError was read as "this song is unplayable". Each skip stamps user_songs.last_played and pushes it
// to the server, so songs the user never heard were permanently recorded as played.
describe("classifyPlaybackError", () => {
    it("treats a dropped or timed-out connection as transient", () => {
        expect(classifyPlaybackError({ code: "android-io-network-connection-failed" })).toBe("transient");
        expect(classifyPlaybackError({ code: "android-io-network-connection-timeout" })).toBe("transient");
        expect(classifyPlaybackError({ code: "android-timeout" })).toBe("transient");
        expect(classifyPlaybackError({ code: "ios_not_connected_to_internet" })).toBe("transient");
        expect(classifyPlaybackError({ code: "web-network" })).toBe("transient");
    });

    it("treats a missing or unreadable source as permanent", () => {
        expect(classifyPlaybackError({ code: "android-io-file-not-found" })).toBe("permanent");
        expect(classifyPlaybackError({ code: "android-io-cleartext-not-permitted" })).toBe("permanent");
        expect(classifyPlaybackError({ code: "android-parsing-container-malformed" })).toBe("permanent");
        expect(classifyPlaybackError({ code: "android-decoder-init-failed" })).toBe("permanent");
        expect(classifyPlaybackError({ code: "android-decoding-format-unsupported" })).toBe("permanent");
        expect(classifyPlaybackError({ code: "ios_track_unplayable" })).toBe("permanent");
    });

    // One media3 code carries both halves of the split: a song deleted server-side and a tunnel restart arrive
    // identically, and only the response code in the message separates them.
    it("splits bad-http-status on the response code in the message", () => {
        const badStatus = (message: string) => classifyPlaybackError({ code: "android-io-bad-http-status", message });
        expect(badStatus("Response code: 404")).toBe("permanent");
        expect(badStatus("Response code: 403")).toBe("permanent");
        expect(badStatus("Response code: 502")).toBe("transient");
        expect(badStatus("Response code: 503")).toBe("transient");
        expect(badStatus("Response code: 429")).toBe("transient");
        expect(badStatus("Response code: 408")).toBe("transient");
    });

    it("falls back to unknown when the status cannot be read, so it retries before it skips", () => {
        expect(classifyPlaybackError({ code: "android-io-bad-http-status" })).toBe("unknown");
        expect(classifyPlaybackError({ code: "android-io-bad-http-status", message: "no number here" })).toBe("unknown");
    });

    // What Android actually delivers: media3's source-error message is the literal "Source error", so the
    // status is never in the event. Without a probe this was "unknown", and unknown skipped after ~3s - one song
    // burned every few seconds for as long as the Cloudflare tunnel was down (2026-10-03).
    it("uses the probed status when the error itself carries none", () => {
        const sourceError = { code: "android-io-bad-http-status", message: "Source error" };
        expect(classifyPlaybackError(sourceError, { probedStatus: 530 })).toBe("transient");
        expect(classifyPlaybackError(sourceError, { probedStatus: 502 })).toBe("transient");
        expect(classifyPlaybackError(sourceError, { probedStatus: "unreachable" })).toBe("transient");
        expect(classifyPlaybackError(sourceError, { probedStatus: 404 })).toBe("permanent");
    });

    it("refines only an unknown, and only in a direction the probe actually shows", () => {
        // The source answering fine says nothing about why the player failed - leave it unknown.
        expect(classifyPlaybackError({ code: "android-unspecified" }, { probedStatus: 200 })).toBe("unknown");
        expect(classifyPlaybackError({ code: "android-unspecified" }, { probedStatus: 206 })).toBe("unknown");
        // An error that already classified is not second-guessed by a probe.
        expect(classifyPlaybackError({ code: "android-decoder-init-failed" }, { probedStatus: "unreachable" })).toBe("permanent");
        expect(classifyPlaybackError({ code: "android-io-network-connection-failed" }, { probedStatus: 404 })).toBe("transient");
        // The status in the message, where a platform provides one, still wins over the probe.
        expect(classifyPlaybackError(
            { code: "android-io-bad-http-status", message: "Response code: 404" },
            { probedStatus: 530 },
        )).toBe("permanent");
        // And a local file is still never waited out.
        expect(classifyPlaybackError({ code: "android-unspecified" }, { isLocalSource: true, probedStatus: "unreachable" })).toBe("permanent");
    });

    it("returns unknown for an unrecognised, empty or missing code", () => {
        expect(classifyPlaybackError({ code: "android-something-new" })).toBe("unknown");
        expect(classifyPlaybackError({ code: "" })).toBe("unknown");
        expect(classifyPlaybackError({ message: "Failed to load resource" })).toBe("unknown");
        expect(classifyPlaybackError(undefined)).toBe("unknown");
        expect(classifyPlaybackError(null)).toBe("unknown");
    });

    it("is tolerant of casing and surrounding whitespace in the code", () => {
        expect(classifyPlaybackError({ code: "  ANDROID-IO-NETWORK-CONNECTION-FAILED " })).toBe("transient");
    });

    // A file already on disk cannot fail because the network did. Waiting one out would stall playback on a
    // song that will never load, which is precisely what skip-on-error exists to prevent.
    it("never calls a local-file failure transient, whatever the code says", () => {
        const local = { isLocalSource: true };
        expect(classifyPlaybackError({ code: "android-io-network-connection-failed" }, local)).toBe("permanent");
        expect(classifyPlaybackError({ code: "android-something-new" }, local)).toBe("permanent");
        expect(classifyPlaybackError(undefined, local)).toBe("permanent");
    });
});

describe("decidePlaybackRecovery", () => {
    it("never skips on a transient fault, at any attempt count", () => {
        for (let attempt = 0; attempt <= MAX_TRANSIENT_ATTEMPTS + 3; attempt++) {
            const recovery = decidePlaybackRecovery({ kind: "transient", attempt, consecutiveSkips: 0 });
            expect(recovery.action).not.toBe("skip");
        }
    });

    it("retries the same track with a growing delay while the budget lasts", () => {
        const delays: number[] = [];
        for (let attempt = 0; attempt < MAX_TRANSIENT_ATTEMPTS; attempt++) {
            const recovery = decidePlaybackRecovery({ kind: "transient", attempt, consecutiveSkips: 0 });
            expect(recovery.action).toBe("retry");
            delays.push(recovery.action === "retry" ? recovery.delayMs : -1);
        }
        // Non-decreasing, and it settles rather than growing without bound.
        expect(delays).toEqual([...delays].sort((a, b) => a - b));
        expect(delays[0]).toBe(RETRY_BACKOFF_MS[0]);
        expect(delays.at(-1)).toBe(RETRY_BACKOFF_MS.at(-1));
    });

    it("halts as offline once the transient budget is spent, rather than advancing the queue", () => {
        expect(decidePlaybackRecovery({ kind: "transient", attempt: MAX_TRANSIENT_ATTEMPTS, consecutiveSkips: 0 }))
            .toEqual({ action: "halt", reason: "offline" });
    });

    it("gives an unknown fault a couple of retries, then treats it as a bad source", () => {
        for (let attempt = 0; attempt < MAX_UNKNOWN_ATTEMPTS; attempt++) {
            expect(decidePlaybackRecovery({ kind: "unknown", attempt, consecutiveSkips: 0 }).action).toBe("retry");
        }
        expect(decidePlaybackRecovery({ kind: "unknown", attempt: MAX_UNKNOWN_ATTEMPTS, consecutiveSkips: 0 }).action)
            .toBe("skip");
    });

    it("skips a permanent fault immediately — no retry budget is spent on it", () => {
        expect(decidePlaybackRecovery({ kind: "permanent", attempt: 0, consecutiveSkips: 0 }))
            .toEqual({ action: "skip" });
    });

    it("bounds a run of unplayable songs so skip-on-error cannot walk the library", () => {
        expect(decidePlaybackRecovery({ kind: "permanent", attempt: 0, consecutiveSkips: MAX_CONSECUTIVE_SKIPS - 1 }))
            .toEqual({ action: "skip" });
        expect(decidePlaybackRecovery({ kind: "permanent", attempt: 0, consecutiveSkips: MAX_CONSECUTIVE_SKIPS }))
            .toEqual({ action: "halt", reason: "unplayable-run" });
    });

    // The reported incident, end to end: three streamed songs fail on a flaky connection and the player must
    // still be sitting on the first of them.
    it("stays on the first song through a burst of connection failures", () => {
        let attempt = 0;
        for (let i = 0; i < 3; i++) {
            const recovery = decidePlaybackRecovery({
                kind: classifyPlaybackError({ code: "android-io-network-connection-failed" }),
                attempt,
                consecutiveSkips: 0,
            });
            expect(recovery.action).toBe("retry");
            attempt++;
        }
        expect(attempt).toBe(3);
    });
});

describe("retryDelayMs", () => {
    it("clamps at both ends instead of returning undefined", () => {
        expect(retryDelayMs(-5)).toBe(RETRY_BACKOFF_MS[0]);
        expect(retryDelayMs(0)).toBe(RETRY_BACKOFF_MS[0]);
        expect(retryDelayMs(RETRY_BACKOFF_MS.length + 50)).toBe(RETRY_BACKOFF_MS.at(-1));
    });
});

describe("isRetryableHttpStatus", () => {
    it("retries server-side and back-off statuses only", () => {
        expect(isRetryableHttpStatus(500)).toBe(true);
        expect(isRetryableHttpStatus(502)).toBe(true);
        expect(isRetryableHttpStatus(429)).toBe(true);
        expect(isRetryableHttpStatus(404)).toBe(false);
        expect(isRetryableHttpStatus(401)).toBe(false);
        expect(isRetryableHttpStatus(200)).toBe(false);
    });
});
