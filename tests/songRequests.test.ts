import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import { SongRequest } from "@/app/services/api/models";
import { SongRequestStatus } from "@/app/enums";
import {
    CAPABILITIES_REFRESH_MS,
    completedRequestFor,
    describeRequestFailure,
    describeSearchFailure,
    describeSongRequest,
    formatSongDuration,
    isInFlightSongRequest,
    newlyCompletedRequests,
    nextCapabilityAnswer,
    SEARCH_MAX_LENGTH,
    SONG_REQUEST_POLL_MS,
    SONG_REQUEST_RETRY_MS,
    searchQuery,
    shouldAskCapabilities,
    shouldPollSongRequests,
    songRequestsCapability,
    visibleSongRequests,
    withSongRequest,
} from "@/app/tools/songRequests";

// Song requests (ShuffullApp#107): the status mapping, the capability gate, and what the screen says when a call fails.

const refused = (status: number, error?: string) =>
    new ApiStatusFailureError("/api/v1/song-requests", { status, data: error ? { error } : undefined });
const noAnswer = () => new AxiosError("timeout of 20000ms exceeded", "ECONNABORTED");

function request(songRequestId: string, status: SongRequestStatus, failureReason: string | null = null): SongRequest {
    return {
        songRequestId,
        externalSongId: `source-${songRequestId}`,
        title: "A song",
        artists: ["An artist"],
        durationSeconds: 200,
        thumbnailUrl: null,
        status,
        failureReason,
        songId: status === SongRequestStatus.Completed ? `song-${songRequestId}` : null,
        targetPlaylistName: "Requests · week of 2026-11-02",
        createdAt: new Date("2026-11-02T10:00:00Z"),
        updatedAt: new Date("2026-11-02T10:00:00Z"),
    };
}

describe("capability gate", () => {
    it("is on only when the server says songRequests: true", () => {
        expect(songRequestsCapability({ capabilities: { songRequests: true } })).toBe("on");
        expect(songRequestsCapability({ capabilities: { songRequests: false } })).toBe("off");
    });

    it("an API without the endpoint (404) is off: it can't change until a redeploy", () => {
        expect(songRequestsCapability({ error: refused(404) })).toBe("off");
    });

    it("no answer or any other failure is unknown, so the feature stays hidden and the next screen asks again", () => {
        expect(songRequestsCapability({ error: noAnswer() })).toBe("unknown");
        expect(songRequestsCapability({ error: refused(500) })).toBe("unknown");
        expect(songRequestsCapability({ error: refused(503) })).toBe("unknown");
        expect(songRequestsCapability({ error: new Error("parse failure") })).toBe("unknown");
    });

    it("a failed ask keeps the last known answer and its age, so going offline doesn't hide the feature", () => {
        const known = { songRequests: "on" as const, askedAt: 1000 };
        expect(nextCapabilityAnswer(known, { error: noAnswer() }, 5000)).toEqual(known);
        expect(nextCapabilityAnswer(known, { error: refused(500) }, 5000)).toEqual(known);
        expect(nextCapabilityAnswer(known, { capabilities: { songRequests: false } }, 5000)).toEqual({ songRequests: "off", askedAt: 5000 });
        expect(nextCapabilityAnswer(known, { error: refused(404) }, 5000)).toEqual({ songRequests: "off", askedAt: 5000 });

        const never = { songRequests: "unknown" as const, askedAt: null };
        expect(nextCapabilityAnswer(never, { error: noAnswer() }, 5000)).toEqual(never);
        expect(nextCapabilityAnswer(never, { capabilities: { songRequests: true } }, 5000)).toEqual({ songRequests: "on", askedAt: 5000 });
    });

    it("asks while unknown, and again once a known answer is an hour old", () => {
        const now = 1_000_000_000;
        expect(shouldAskCapabilities("unknown", null, now)).toBe(true);
        expect(shouldAskCapabilities("unknown", now, now)).toBe(true);
        expect(shouldAskCapabilities("on", now - 1000, now)).toBe(false);
        expect(shouldAskCapabilities("off", now - CAPABILITIES_REFRESH_MS + 1, now)).toBe(false);
        expect(shouldAskCapabilities("off", now - CAPABILITIES_REFRESH_MS, now)).toBe(true);
        expect(shouldAskCapabilities("on", null, now)).toBe(true);
    });
});

describe("status mapping", () => {
    it("maps every status the API sends to a label, and offers cancel only while Pending and retry only once Failed", () => {
        const rows = [
            SongRequestStatus.Pending,
            SongRequestStatus.Accepted,
            SongRequestStatus.Downloading,
            SongRequestStatus.Retrying,
            SongRequestStatus.Failed,
            SongRequestStatus.Completed,
            SongRequestStatus.Cancelled,
        ].map(status => {
            const view = describeSongRequest({ status, failureReason: null });
            return [SongRequestStatus[status], view.label, view.tone, view.canCancel, view.canRetry];
        });
        expect(rows).toEqual([
            ["Pending", "Pending", "active", true, false],
            ["Accepted", "Queued", "active", false, false],
            ["Downloading", "Downloading", "active", false, false],
            ["Retrying", "Retrying", "active", false, false],
            ["Failed", "Failed", "failed", false, true],
            ["Completed", "Added", "done", false, false],
            ["Cancelled", "Cancelled", "muted", false, false],
        ]);
    });

    it("a failure shows its reason", () => {
        expect(describeSongRequest({ status: SongRequestStatus.Failed, failureReason: " Video unavailable " }).label)
            .toBe("Failed: Video unavailable");
        expect(describeSongRequest({ status: SongRequestStatus.Failed, failureReason: "  " }).label).toBe("Failed");
    });

    it("a status from a newer server is shown but offers nothing", () => {
        expect(describeSongRequest({ status: 42, failureReason: null }))
            .toEqual({ label: "Unknown status", tone: "muted", canCancel: false, canRetry: false });
    });

    it("in flight is everything the producer can still move on by itself: Failed waits for the user", () => {
        const inFlight = Object.values(SongRequestStatus).filter((v): v is number => typeof v === "number").filter(isInFlightSongRequest);
        expect(inFlight).toEqual([
            SongRequestStatus.Pending,
            SongRequestStatus.Accepted,
            SongRequestStatus.Downloading,
            SongRequestStatus.Retrying,
        ]);
    });
});

describe("polling and Completed", () => {
    it("polls every 5 s while the producer is working on a request, and not at all otherwise", () => {
        const working = [request("a", SongRequestStatus.Completed), request("b", SongRequestStatus.Downloading)];
        expect(shouldPollSongRequests(working, SONG_REQUEST_POLL_MS)).toBe(true);
        expect(shouldPollSongRequests(working, SONG_REQUEST_POLL_MS - 1)).toBe(false);

        expect(shouldPollSongRequests([], SONG_REQUEST_RETRY_MS)).toBe(false);
        expect(shouldPollSongRequests([request("a", SongRequestStatus.Completed), request("b", SongRequestStatus.Cancelled)], SONG_REQUEST_RETRY_MS)).toBe(false);
        // A Failed request stays Failed until the user retries it, so it would keep the list polling forever.
        expect(shouldPollSongRequests([request("a", SongRequestStatus.Failed)], SONG_REQUEST_RETRY_MS * 10)).toBe(false);
    });

    it("while the first read keeps failing, tries again once a minute", () => {
        expect(shouldPollSongRequests(null, SONG_REQUEST_POLL_MS)).toBe(false);
        expect(shouldPollSongRequests(null, SONG_REQUEST_RETRY_MS)).toBe(true);
    });

    it("play-now finds a request this user already completed for the result, so a replay files nothing", () => {
        const done = request("done", SongRequestStatus.Completed);
        const list = [request("open", SongRequestStatus.Pending), done];
        expect(completedRequestFor(list, done.externalSongId)?.songId).toBe("song-done");
        expect(completedRequestFor(list, "source-open")).toBeUndefined();
        expect(completedRequestFor([{ ...done, songId: null }], done.externalSongId)).toBeUndefined();
        expect(completedRequestFor(null, done.externalSongId)).toBeUndefined();
    });

    it("the first read syncs nothing: those requests completed before the screen opened", () => {
        expect(newlyCompletedRequests(null, [request("a", SongRequestStatus.Completed)])).toEqual([]);
    });

    it("a request seen moving to Completed, or first seen Completed, triggers a sync; one already Completed doesn't", () => {
        const previous = [
            request("moved", SongRequestStatus.Downloading),
            request("failed-then-imported", SongRequestStatus.Failed),
            request("already", SongRequestStatus.Completed),
            request("still", SongRequestStatus.Retrying),
        ];
        const next = [
            request("new", SongRequestStatus.Completed),
            request("moved", SongRequestStatus.Completed),
            request("failed-then-imported", SongRequestStatus.Completed),
            request("already", SongRequestStatus.Completed),
            request("still", SongRequestStatus.Retrying),
        ];
        expect(newlyCompletedRequests(previous, next).map(r => r.songRequestId)).toEqual(["new", "moved", "failed-then-imported"]);
    });

    it("cancelled requests drop out of the list; a changed request replaces its row, a new one goes first", () => {
        const list = [request("a", SongRequestStatus.Pending), request("b", SongRequestStatus.Cancelled)];
        expect(visibleSongRequests(list).map(r => r.songRequestId)).toEqual(["a"]);

        const retried = withSongRequest(list, request("a", SongRequestStatus.Downloading));
        expect(retried.map(r => [r.songRequestId, r.status])).toEqual([["a", SongRequestStatus.Downloading], ["b", SongRequestStatus.Cancelled]]);
        expect(withSongRequest(list, request("c", SongRequestStatus.Pending)).map(r => r.songRequestId)).toEqual(["c", "a", "b"]);
    });
});

describe("failure messages", () => {
    it("search: 503 is search unavailable, 429 is too many searches, no answer is the connection", () => {
        expect(describeSearchFailure(refused(503, "Song search is unavailable."))).toBe("Search isn't available right now. Try again in a bit.");
        expect(describeSearchFailure(refused(429, "Too many searches. Wait a moment and try again."))).toBe("Too many searches. Wait a moment and try again.");
        expect(describeSearchFailure(noAnswer())).toBe("Can't reach the server. Check your connection and try again.");
        expect(describeSearchFailure(refused(530))).toBe("Can't reach the server. Check your connection and try again.");
    });

    it("search: a 400 says the server's reason; anything else says its status", () => {
        expect(describeSearchFailure(refused(400, "Search text is required."))).toBe("Search text is required.");
        expect(describeSearchFailure(refused(500))).toBe("Search failed (error 500). Try again.");
    });

    it("request: the server's reason for a 409, the connection when there's no answer", () => {
        expect(describeRequestFailure(refused(409, "You already requested this song; it is Pending.")))
            .toBe("You already requested this song; it is Pending.");
        expect(describeRequestFailure(noAnswer())).toBe("Can't reach the server. Check your connection and try again.");
        expect(describeRequestFailure(refused(500))).toBe("That didn't work (error 500). Try again.");
    });
});

describe("search input", () => {
    it("searches from two characters, trimmed, and never longer than the API accepts", () => {
        expect(searchQuery("")).toBeNull();
        expect(searchQuery(" a ")).toBeNull();
        expect(searchQuery("  ab ")).toBe("ab");
        expect(searchQuery("x".repeat(SEARCH_MAX_LENGTH + 5))).toHaveLength(SEARCH_MAX_LENGTH);
    });

    it("formats a result's length as m:ss, and nothing when it isn't known", () => {
        expect(formatSongDuration(230)).toBe("3:50");
        expect(formatSongDuration(59.6)).toBe("1:00");
        expect(formatSongDuration(null)).toBeNull();
    });
});
