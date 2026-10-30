import { describe, it, expect, beforeEach } from "vitest";
import { Lookahead, LookaheadSource } from "@/app/tools/lookahead";

/**
 * The lookahead decides skip()'s next songs before the skip, so they can be fetched first (ShuffullApp#124). The
 * risk it carries is playing something skip() would no longer have picked: a song from the old scope, a disliked
 * song, or a shuffle pick jumping ahead of a song the user just queued. Each re-pick case below is one of those.
 */

/** A fake player state: a queue, forward history, and a shuffle that hands out songs from a list in order. */
class FakeSource implements LookaheadSource {
    playing: string | undefined = "now";
    queued: string[] = [];
    history: string[] = [];
    pool: string[] = [];
    ineligible = new Set<string>();
    picksRequested: (readonly string[])[] = [];
    // Runs inside pick(), to simulate something happening mid-refresh.
    duringPick: (() => void) | undefined;

    current() {
        return this.playing;
    }

    queue() {
        return this.queued;
    }

    async forwardHistory(limit: number) {
        return this.history.slice(0, limit);
    }

    async pick(played: readonly string[]) {
        this.picksRequested.push([...played]);
        this.duringPick?.();
        return this.pool.find(songId => !played.includes(songId) && !this.ineligible.has(songId)) ?? this.pool[0];
    }

    async isEligible(songId: string) {
        return !this.ineligible.has(songId) && this.pool.includes(songId);
    }
}

describe("lookahead", () => {
    let source: FakeSource;
    let lookahead: Lookahead;

    beforeEach(() => {
        source = new FakeSource();
        source.pool = ["a", "b", "c", "d"];
        lookahead = new Lookahead(source, 2);
    });

    it("lines up two shuffle picks, telling the shuffle what will have played by then", async () => {
        expect(await lookahead.refresh()).toEqual(["a", "b"]);
        expect(source.picksRequested).toEqual([["now"], ["now", "a"]]);
        expect(lookahead.reservedPicks).toEqual(["a", "b"]);
    });

    it("keeps its picks across refreshes, so the song being fetched doesn't change under it", async () => {
        await lookahead.refresh();
        source.pool = ["d", "c", "b", "a"];

        expect(await lookahead.refresh()).toEqual(["a", "b"]);
    });

    it("hands skip() its first pick, then picks one more behind the other", async () => {
        await lookahead.refresh();

        expect(await lookahead.takePick()).toBe("a");
        source.playing = "a";
        expect(await lookahead.refresh()).toEqual(["b", "c"]);
    });

    it("re-picks everything when the scope or filters change", async () => {
        await lookahead.refresh();
        lookahead.reset();
        source.pool = ["x", "y"];

        expect(lookahead.reservedPicks).toEqual([]);
        expect(await lookahead.takePick()).toBeUndefined();
        expect(await lookahead.refresh()).toEqual(["x", "y"]);
    });

    it("re-picks a disliked song and keeps the rest", async () => {
        await lookahead.refresh();
        source.ineligible.add("a");

        expect(lookahead.forget("a")).toBe(true);
        expect(await lookahead.refresh()).toEqual(["b", "c"]);
    });

    it("ignores a dislike of a song it hasn't lined up", async () => {
        await lookahead.refresh();

        expect(lookahead.forget("zzz")).toBe(false);
        expect(lookahead.reservedPicks).toEqual(["a", "b"]);
    });

    it("puts a queued song first and drops the last pick to make room", async () => {
        await lookahead.refresh();
        source.queued = ["q1"];

        expect(await lookahead.refresh()).toEqual(["q1", "a"]);
        expect(lookahead.reservedPicks).toEqual(["a"]);
    });

    it("lines up only queued songs when the queue fills it, and nothing from the shuffle", async () => {
        await lookahead.refresh();
        source.queued = ["q1", "q2", "q3"];

        expect(await lookahead.refresh()).toEqual(["q1", "q2"]);
        expect(lookahead.reservedPicks).toEqual([]);
    });

    it("after previous(), lines up the songs that came after it, as skip() will replay them", async () => {
        await lookahead.refresh();
        source.history = ["h1"];

        expect(await lookahead.refresh()).toEqual(["h1", "a"]);

        source.history = ["h1", "h2", "h3"];
        expect(await lookahead.refresh()).toEqual(["h1", "h2"]);
    });

    it("ignores forward history while the queue has songs, as skip() does", async () => {
        source.queued = ["q1"];
        source.history = ["h1", "h2"];

        expect(await lookahead.refresh()).toEqual(["q1", "a"]);
    });

    it("drops a pick that left the scope while it waited", async () => {
        await lookahead.refresh();
        source.ineligible.add("b");

        expect(await lookahead.refresh()).toEqual(["a", "c"]);
    });

    it("refuses a pick at skip time that may no longer play, so skip() shuffles fresh", async () => {
        await lookahead.refresh();
        source.ineligible.add("a");

        expect(await lookahead.takePick()).toBeUndefined();
        // And it doesn't come back.
        expect(lookahead.reservedPicks).toEqual(["b"]);
    });

    it("stops short rather than line up one song twice when the pool is too small", async () => {
        source.pool = ["only"];

        expect(await lookahead.refresh()).toEqual(["only"]);
    });

    it("lines up nothing from an empty pool", async () => {
        source.pool = [];

        expect(await lookahead.refresh()).toEqual([]);
    });

    it("discards a refresh that a reset overtook, so the old scope's picks don't come back", async () => {
        source.duringPick = () => {
            source.duringPick = undefined;
            lookahead.reset();
        };

        expect(await lookahead.refresh()).toBeUndefined();
        expect(lookahead.reservedPicks).toEqual([]);
    });

    it("discards a refresh that a skip overtook, so the pick skip() took isn't lined up again", async () => {
        await lookahead.refresh();
        source.queued = ["q1"];
        source.duringPick = undefined;
        // A refresh starting now reads the picks, then skip() takes one before it writes back.
        const refreshing = lookahead.refresh();
        await lookahead.takePick();

        expect(await refreshing).toBeUndefined();
        expect(lookahead.reservedPicks).toEqual(["b"]);
    });
});
