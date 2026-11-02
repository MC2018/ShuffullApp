import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { SongRequest } from "@/app/services/api/models";
import { PlayNextIntent } from "@/app/services/db/models";
import { deletePlayNextIntent, getPlayNextIntents, savePlayNextIntent, updatePlayNextIntent } from "@/app/services/db/queries/playNext";
import { SongRequestStatus } from "@/app/enums";
import {
    combineMessages,
    decidePlayNext,
    describeUpNext,
    needsRequestStatus,
    PLAY_NEXT_MAX_AGE_MS,
    PLAY_NEXT_UNFILED_MS,
    PLAY_NEXT_WAIT_MS,
    PlayNextContext,
    resolveIntent,
    withPlayNextFirst,
} from "@/app/tools/playNext";
import { openRequestFor } from "@/app/tools/songRequests";

// "Request & play next" (ShuffullApp#108): what happens to each intent after a sync, the queue it builds, the label it
// shows, and the rows that hold it.

const TAP = new Date("2026-11-02T10:00:00Z");
const MIN = 60_000;

function intent(change: Partial<PlayNextIntent> = {}): PlayNextIntent {
    return { userId: "u1", externalSongId: "yt-1", songRequestId: null, title: "A song", songId: null, createdAt: TAP, ...change };
}

function request(status: SongRequestStatus, change: Partial<SongRequest> = {}): SongRequest {
    return {
        songRequestId: "r1",
        externalSongId: "yt-1",
        title: "A song",
        artists: ["An artist"],
        durationSeconds: 200,
        thumbnailUrl: null,
        status,
        failureReason: null,
        songId: status === SongRequestStatus.Completed ? "s1" : null,
        targetPlaylistName: "Requests · week of 2026-11-02",
        createdAt: TAP,
        updatedAt: TAP,
        ...change,
    };
}

function context(change: Partial<PlayNextContext> & { local?: string[] } = {}): PlayNextContext {
    const local = change.local ?? [];
    return { listRead: true, isLocal: (id) => local.includes(id), current: "playing", now: TAP.getTime() + MIN, ...change };
}

const decide = (i: PlayNextIntent, requests: SongRequest[] | null, c: PlayNextContext = context()) => decidePlayNext(resolveIntent(i, requests), c);

describe("resolving an intent against the request list", () => {
    it("follows its request id, and learns the song once the request completes", () => {
        const resolved = resolveIntent(intent({ songRequestId: "r1" }), [request(SongRequestStatus.Completed)]);
        expect(resolved).toMatchObject({ songRequestId: "r1", songId: "s1" });
    });

    it("an intent whose create call never answered adopts the request the server touched since the tap", () => {
        const resolved = resolveIntent(intent(), [request(SongRequestStatus.Downloading, { songRequestId: "r7" })]);
        expect(resolved).toMatchObject({ songRequestId: "r7", songId: null });
    });

    it("but not an old request for the same song, finished long before the tap", () => {
        const old = request(SongRequestStatus.Cancelled, { updatedAt: new Date(TAP.getTime() - 60 * MIN) });
        expect(resolveIntent(intent(), [old]).request).toBeUndefined();
    });

    it("nor a request that failed or was cancelled just before the tap", () => {
        const justBefore = new Date(TAP.getTime() - MIN);
        for (const status of [SongRequestStatus.Failed, SongRequestStatus.Cancelled]) {
            expect(resolveIntent(intent(), [request(status, { updatedAt: justBefore })]).request).toBeUndefined();
        }
    });

    it("with no list read, keeps what the row already knows", () => {
        expect(resolveIntent(intent({ songRequestId: "r1", songId: "s1" }), null)).toMatchObject({ songRequestId: "r1", songId: "s1" });
    });

    it("only an intent without its song still needs the request's status", () => {
        expect(needsRequestStatus(intent({ songRequestId: "r1" }))).toBe(true);
        expect(needsRequestStatus(intent({ songRequestId: "r1", songId: "s1" }))).toBe(false);
    });
});

describe("deciding what to do with an intent", () => {
    it("queues the song once it is on this device", () => {
        expect(decide(intent({ songRequestId: "r1" }), [request(SongRequestStatus.Completed)], context({ local: ["s1"] })))
            .toEqual({ kind: "queue", songId: "s1" });
    });

    it("waits while the song is completed but not synced down yet", () => {
        expect(decide(intent({ songRequestId: "r1" }), [request(SongRequestStatus.Completed)])).toEqual({ kind: "wait" });
    });

    it("waits while the producer works on it", () => {
        for (const status of [SongRequestStatus.Pending, SongRequestStatus.Accepted, SongRequestStatus.Downloading, SongRequestStatus.Retrying]) {
            expect(decide(intent({ songRequestId: "r1" }), [request(status)])).toEqual({ kind: "wait" });
        }
    });

    it("is done, quietly, once its song is the one playing", () => {
        expect(decide(intent({ songRequestId: "r1", songId: "s1" }), null, context({ current: "s1", local: ["s1"] })))
            .toEqual({ kind: "drop", message: null });
    });

    it("drops a failed request and says why", () => {
        const failed = request(SongRequestStatus.Failed, { failureReason: "Video unavailable" });
        expect(decide(intent({ songRequestId: "r1" }), [failed]))
            .toEqual({ kind: "drop", message: "\"A song\" won't play next: its request failed (Video unavailable)." });
    });

    it("drops a cancelled request and says so", () => {
        expect(decide(intent({ songRequestId: "r1" }), [request(SongRequestStatus.Cancelled)]))
            .toEqual({ kind: "drop", message: "\"A song\" won't play next: its request was cancelled." });
    });

    it("a song already queued plays even if its request has since dropped out of the list", () => {
        expect(decide(intent({ songRequestId: "r1", songId: "s1" }), [], context({ local: ["s1"] }))).toEqual({ kind: "queue", songId: "s1" });
    });

    it("a request gone from the list (it holds the newest 50) waits, then ends with the wait", () => {
        const i = intent({ songRequestId: "r1" });
        expect(decide(i, [])).toEqual({ kind: "wait" });
        const late = decide(i, [], context({ now: TAP.getTime() + PLAY_NEXT_WAIT_MS + 1 }));
        expect(late).toMatchObject({ kind: "drop", message: expect.stringContaining("took too long") });
    });

    it("a song that never arrives ends with the wait too", () => {
        const late = decide(intent({ songRequestId: "r1" }), [request(SongRequestStatus.Retrying)], context({ now: TAP.getTime() + PLAY_NEXT_WAIT_MS + 1 }));
        expect(late).toMatchObject({ kind: "drop", message: expect.stringContaining("took too long") });
    });

    it("a queued song nobody got to is dropped quietly after a day, so it can't jump the queue after a restart", () => {
        const stale = decide(intent({ songRequestId: "r1", songId: "s1" }), null, context({ local: ["s1"], now: TAP.getTime() + PLAY_NEXT_MAX_AGE_MS + 1 }));
        expect(stale).toEqual({ kind: "drop", message: null });
    });

    it("a request that never reached the server is reported once the list has had time to show it", () => {
        expect(decide(intent(), [])).toEqual({ kind: "wait" });
        const after = context({ now: TAP.getTime() + PLAY_NEXT_UNFILED_MS + 1 });
        expect(decide(intent(), [], after)).toMatchObject({ kind: "drop", message: expect.stringContaining("didn't reach the server") });
        // Unless the list was never read: nothing is concluded from a list this device doesn't have.
        expect(decide(intent(), null, { ...after, listRead: false })).toEqual({ kind: "wait" });
    });

    it("several endings make one message", () => {
        expect(combineMessages([null, "one", null, "two"])).toBe("one\n\ntwo");
        expect(combineMessages([null])).toBeNull();
    });
});

describe("the play queue", () => {
    it("puts the songs at the front, in order, and moves nothing else", () => {
        expect(withPlayNextFirst(["a", "b"], ["s1", "s2"], "now")).toEqual(["s1", "s2", "a", "b"]);
    });

    it("a song already queued moves to the front rather than playing twice", () => {
        expect(withPlayNextFirst(["a", "s1", "b"], ["s1"], "now")).toEqual(["s1", "a", "b"]);
    });

    it("returns the same queue when it is already right, so the caller can skip the refresh", () => {
        const queue = ["s1", "a"];
        expect(withPlayNextFirst(queue, ["s1"], "now")).toBe(queue);
        expect(withPlayNextFirst(queue, [], "now")).toBe(queue);
    });

    it("leaves out the song playing now", () => {
        expect(withPlayNextFirst(["a"], ["now", "s1"], "now")).toEqual(["s1", "a"]);
    });
});

describe("the Up next label", () => {
    it("says nothing with no intent", () => {
        expect(describeUpNext([], [])).toBeNull();
    });

    it("says the song is coming while it waits, and Up next once queued", () => {
        expect(describeUpNext([intent()], [])).toBe("Next, once it arrives: A song");
        expect(describeUpNext([intent({ songId: "s1" })], [])).toBe("Next, once it arrives: A song");
        expect(describeUpNext([intent({ songId: "s1" })], ["s1"])).toBe("Up next: A song");
    });

    it("names the song that is queued, even when an older one is still on its way", () => {
        const waiting = intent({ externalSongId: "yt-0", title: "Older" });
        expect(describeUpNext([waiting, intent({ songId: "s1" })], ["s1"])).toBe("Up next: A song (+1)");
    });

    it("counts the rest", () => {
        expect(describeUpNext([intent(), intent({ externalSongId: "yt-2", title: "Other" })], [])).toBe("Next, once it arrives: A song (+1)");
    });
});

describe("a search result's open request", () => {
    it("is one the producer still works on, not a failed or finished one", () => {
        expect(openRequestFor([request(SongRequestStatus.Downloading)], "yt-1")?.songRequestId).toBe("r1");
        expect(openRequestFor([request(SongRequestStatus.Failed), request(SongRequestStatus.Cancelled)], "yt-1")).toBeUndefined();
        expect(openRequestFor([request(SongRequestStatus.Pending)], "yt-2")).toBeUndefined();
    });
});

describe("the intent rows", () => {
    function freshDb(): GenericDb {
        const db = drizzle(new Database(":memory:"));
        migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
        return db as unknown as GenericDb;
    }

    it("round-trip, oldest first, per user", async () => {
        const db = freshDb();
        await savePlayNextIntent(db, intent({ externalSongId: "yt-2", createdAt: new Date(TAP.getTime() + MIN) }));
        await savePlayNextIntent(db, intent());
        await savePlayNextIntent(db, intent({ userId: "u2" }));
        expect((await getPlayNextIntents(db, "u1")).map(i => i.externalSongId)).toEqual(["yt-1", "yt-2"]);
        expect(await getPlayNextIntents(db, "u1")).toContainEqual(intent());
    });

    it("a second tap on the same song starts the intent over", async () => {
        const db = freshDb();
        await savePlayNextIntent(db, intent({ songRequestId: "r1", songId: "s1" }));
        const again = intent({ createdAt: new Date(TAP.getTime() + MIN) });
        await savePlayNextIntent(db, again);
        expect(await getPlayNextIntents(db, "u1")).toEqual([again]);
    });

    it("an update or delete aimed at a replaced tap leaves the new one alone", async () => {
        const db = freshDb();
        const first = intent();
        await savePlayNextIntent(db, first);
        const again = intent({ createdAt: new Date(TAP.getTime() + MIN) });
        await savePlayNextIntent(db, again);

        await updatePlayNextIntent(db, first, { songRequestId: "old" });
        await deletePlayNextIntent(db, first);
        expect(await getPlayNextIntents(db, "u1")).toEqual([again]);

        await updatePlayNextIntent(db, again, { songRequestId: "r2", songId: "s2" });
        expect(await getPlayNextIntents(db, "u1")).toEqual([{ ...again, songRequestId: "r2", songId: "s2" }]);
        await deletePlayNextIntent(db, again);
        expect(await getPlayNextIntents(db, "u1")).toEqual([]);
    });
});
