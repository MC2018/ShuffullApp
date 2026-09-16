import { describe, it, expect } from "vitest";
import {
    groupRequestsIntoBatches,
    partitionRejectedRequests,
    summarizeRetagFailures,
    OUTBOX_MAX_BATCH_SIZE,
    REJECTED_REQUEST_MAX_AGE_MS,
} from "@/app/services/sync-manager/syncLogic";
import { RequestType } from "@/app/enums";

// The rules that decide what happens to a queued outbox row once the server has answered. These exist
// because the previous behaviour — delete on any 2xx OR 4xx, response body discarded — is what silently
// destroyed 34 kept songs: with the site's AI disabled every item came back "failed" inside a 200.

describe("summarizeRetagFailures (a 200 does not mean the work ran)", () => {
    it("reports the songs that came back failed", () => {
        const { songIds, reasons } = summarizeRetagFailures([
            { songId: "ok", outcome: "enriched" },
            { songId: "locked", outcome: "skipped" },
            { songId: "bad", outcome: "failed", error: "AI is not enabled; cannot enrich songs." },
        ]);

        expect(songIds).toEqual(["bad"]);
        expect(reasons).toEqual(["AI is not enabled; cannot enrich songs."]);
    });

    it("the exact production case: every item failed inside a 200", () => {
        const results = ["a", "b", "c"].map(songId => ({
            songId,
            outcome: "failed" as const,
            error: "AI is not enabled; cannot enrich songs.",
        }));

        const { songIds, reasons } = summarizeRetagFailures(results);

        expect(songIds).toEqual(["a", "b", "c"]);
        expect(reasons).toHaveLength(1); // one distinct reason, not three copies
    });

    it("collapses duplicate reasons but keeps every song id", () => {
        const { songIds, reasons } = summarizeRetagFailures([
            { songId: "a", outcome: "failed", error: "boom" },
            { songId: "b", outcome: "failed", error: "boom" },
            { songId: "c", outcome: "failed", error: "different" },
        ]);

        expect(songIds).toEqual(["a", "b", "c"]);
        expect(reasons).toEqual(["boom", "different"]);
    });

    it("substitutes a placeholder when the server gave no reason", () => {
        expect(summarizeRetagFailures([{ songId: "a", outcome: "failed" }]).reasons).toEqual(["(no reason given)"]);
        expect(summarizeRetagFailures([{ songId: "a", outcome: "failed", error: "  " }]).reasons).toEqual(["(no reason given)"]);
        expect(summarizeRetagFailures([{ songId: "a", outcome: "failed", error: null }]).reasons).toEqual(["(no reason given)"]);
    });

    it("is silent when everything succeeded", () => {
        expect(summarizeRetagFailures([
            { songId: "a", outcome: "enriched" },
            { songId: "b", outcome: "skipped" },
        ]).songIds).toEqual([]);
    });

    it("tolerates a missing or empty body rather than throwing mid-sync", () => {
        expect(summarizeRetagFailures(undefined).songIds).toEqual([]);
        expect(summarizeRetagFailures(null).songIds).toEqual([]);
        expect(summarizeRetagFailures([]).songIds).toEqual([]);
    });
});

describe("partitionRejectedRequests (a 4xx must not delete work silently)", () => {
    const now = new Date("2026-08-22T00:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const DAY = 24 * 60 * 60 * 1000;

    it("keeps a freshly rejected row so a transient cause can clear", () => {
        const rows = [{ requestId: "r1", timeRequested: ago(60_000) }];

        const { abandon, keep } = partitionRejectedRequests(rows, now);

        expect(keep).toHaveLength(1);
        expect(abandon).toHaveLength(0);
    });

    it("abandons a row past the retry window so the queue can never wedge", () => {
        const rows = [{ requestId: "old", timeRequested: ago(REJECTED_REQUEST_MAX_AGE_MS + 1000) }];

        const { abandon, keep } = partitionRejectedRequests(rows, now);

        expect(abandon.map(r => r.requestId)).toEqual(["old"]);
        expect(keep).toHaveLength(0);
    });

    it("splits a mixed batch by age", () => {
        const rows = [
            { requestId: "fresh", timeRequested: ago(DAY) },
            { requestId: "stale", timeRequested: ago(30 * DAY) },
            { requestId: "borderline", timeRequested: ago(REJECTED_REQUEST_MAX_AGE_MS - 1000) },
        ];

        const { abandon, keep } = partitionRejectedRequests(rows, now);

        expect(abandon.map(r => r.requestId)).toEqual(["stale"]);
        expect(keep.map(r => r.requestId)).toEqual(["fresh", "borderline"]);
    });

    it("treats exactly-at-the-window as still retryable (strictly older is abandoned)", () => {
        const rows = [{ requestId: "exact", timeRequested: ago(REJECTED_REQUEST_MAX_AGE_MS) }];

        expect(partitionRejectedRequests(rows, now).keep).toHaveLength(1);
    });

    it("keeps rows with an unusable timestamp — when in doubt, keep the user's work", () => {
        const rows = [
            { requestId: "nan", timeRequested: new Date(NaN) },
            { requestId: "missing", timeRequested: undefined as unknown as Date },
        ];

        const { abandon, keep } = partitionRejectedRequests(rows, now);

        expect(abandon).toHaveLength(0);
        expect(keep).toHaveLength(2);
    });

    it("honours a caller-supplied window", () => {
        const rows = [{ requestId: "r", timeRequested: ago(2 * DAY) }];

        expect(partitionRejectedRequests(rows, now, DAY).abandon).toHaveLength(1);
        expect(partitionRejectedRequests(rows, now, 3 * DAY).keep).toHaveLength(1);
    });

    it("handles an empty batch", () => {
        const { abandon, keep } = partitionRejectedRequests([], now);
        expect(abandon).toEqual([]);
        expect(keep).toEqual([]);
    });
});

describe("groupRequestsIntoBatches (a batch the server would refuse is a stuck batch)", () => {
    const row = (requestType: RequestType, id: string) => ({ requestType, requestId: id });

    it("coalesces consecutive rows of a batched type", () => {
        const batches = groupRequestsIntoBatches([
            row(RequestType.SongRetag, "a"),
            row(RequestType.SongRetag, "b"),
            row(RequestType.SongRetag, "c"),
        ]);

        expect(batches).toHaveLength(1);
        expect(batches[0].map(r => r.requestId)).toEqual(["a", "b", "c"]);
    });

    it("never exceeds the server's cap, so an oversized backlog still drains", () => {
        // RetagSongsHandler.MaxBatch is 200 and REJECTS anything larger — one 201-row POST could only ever
        // 400, forever. Splitting is what lets a large offline backlog actually clear.
        const rows = Array.from({ length: OUTBOX_MAX_BATCH_SIZE + 1 }, (_, i) => row(RequestType.SongRetag, `s${i}`));

        const batches = groupRequestsIntoBatches(rows);

        expect(batches).toHaveLength(2);
        expect(batches[0]).toHaveLength(OUTBOX_MAX_BATCH_SIZE);
        expect(batches[1]).toHaveLength(1);
        expect(batches.flat()).toHaveLength(rows.length); // nothing dropped in the split
    });

    it("splits an exact multiple without leaving an empty batch", () => {
        const rows = Array.from({ length: 6 }, (_, i) => row(RequestType.SongRetag, `s${i}`));

        const batches = groupRequestsIntoBatches(rows, 3);

        expect(batches.map(b => b.length)).toEqual([3, 3]);
    });

    it("gives each Individual row its own batch", () => {
        const batches = groupRequestsIntoBatches([
            row(RequestType.SetSongLikeStatus, "a"),
            row(RequestType.SetSongLikeStatus, "b"),
        ]);

        expect(batches.map(b => b.length)).toEqual([1, 1]);
    });

    it("keeps only the first OnlyOnce row per type", () => {
        const batches = groupRequestsIntoBatches([
            row(RequestType.Authenticate, "first"),
            row(RequestType.Authenticate, "duplicate"),
        ]);

        expect(batches).toHaveLength(1);
        expect(batches[0][0].requestId).toBe("first");
    });

    it("a dropped OnlyOnce duplicate does not split the batched run around it", () => {
        const batches = groupRequestsIntoBatches([
            row(RequestType.Authenticate, "auth"),
            row(RequestType.SongRetag, "a"),
            row(RequestType.Authenticate, "dupe"), // dropped
            row(RequestType.SongRetag, "b"),
        ]);

        expect(batches).toHaveLength(2);
        expect(batches[1].map(r => r.requestId)).toEqual(["a", "b"]);
    });

    it("starts a new batch when the type changes", () => {
        const batches = groupRequestsIntoBatches([
            row(RequestType.SongRetag, "a"),
            row(RequestType.UpdateSongLastPlayed, "b"),
            row(RequestType.SongRetag, "c"),
        ]);

        expect(batches.map(b => b.map(r => r.requestId))).toEqual([["a"], ["b"], ["c"]]);
    });

    it("drops ProcessingMethod.None rows entirely", () => {
        const batches = groupRequestsIntoBatches([row(RequestType.OverallSync, "sync")]);
        expect(batches).toEqual([]);
    });

    it("preserves queue order across the whole result", () => {
        const batches = groupRequestsIntoBatches([
            row(RequestType.SongRetag, "1"),
            row(RequestType.SetSongLikeStatus, "2"),
            row(RequestType.SongRetag, "3"),
            row(RequestType.SongRetag, "4"),
        ]);

        expect(batches.flat().map(r => r.requestId)).toEqual(["1", "2", "3", "4"]);
    });

    it("handles an empty queue", () => {
        expect(groupRequestsIntoBatches([])).toEqual([]);
    });
});
