import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import { SongRequest } from "@/app/services/api/models";
import { SongRequestStatus } from "@/app/enums";
import {
    CAPABILITIES_REFRESH_MS,
    describeRequestFailure,
    describeSearchFailure,
    describeSongRequest,
    formatSongDuration,
    isOpenSongRequest,
    newlyCompletedRequests,
    SEARCH_MAX_LENGTH,
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

    it("open is the API's SongRequestRules.Open: everything up to and including Failed", () => {
        const open = Object.values(SongRequestStatus).filter((v): v is number => typeof v === "number").filter(isOpenSongRequest);
        expect(open).toEqual([
            SongRequestStatus.Pending,
            SongRequestStatus.Accepted,
            SongRequestStatus.Downloading,
            SongRequestStatus.Retrying,
            SongRequestStatus.Failed,
        ]);
    });
});

describe("polling and Completed", () => {
    it("polls while any request is open, a Failed one included (a late import can still complete it)", () => {
        expect(shouldPollSongRequests([])).toBe(false);
        expect(shouldPollSongRequests([request("a", SongRequestStatus.Completed), request("b", SongRequestStatus.Cancelled)])).toBe(false);
        expect(shouldPollSongRequests([request("a", SongRequestStatus.Completed), request("b", SongRequestStatus.Downloading)])).toBe(true);
        expect(shouldPollSongRequests([request("a", SongRequestStatus.Failed)])).toBe(true);
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
