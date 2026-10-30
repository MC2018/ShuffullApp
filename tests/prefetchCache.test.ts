import { describe, it, expect } from "vitest";
import { choosePrefetchEvictions, parsePrefetchSetting, PrefetchEntry, PREFETCH_CACHE_CAP_BYTES } from "@/app/tools/prefetchCache";

/**
 * The prefetch cache holds the song playing now plus the lookahead, and nothing else for long (ShuffullApp#124).
 * What must never happen: the playing file deleted from under the player, the cache growing past its cap, or the
 * cap making the prefetcher evict and refetch the same two songs forever.
 */

const MB = 1024 * 1024;

function entry(songId: string, fetchedAt: number, bytes = 10 * MB, played = false): PrefetchEntry {
    return { songId, bytes, fetchedAt, played };
}

describe("prefetch eviction", () => {
    it("keeps the lookahead while it fits", () => {
        const entries = [entry("a", 1), entry("b", 2)];

        expect(choosePrefetchEvictions(entries, { wanted: ["a", "b"], playing: undefined, capBytes: 100 * MB })).toEqual([]);
    });

    it("drops a song once it has played, but not while it is playing", () => {
        const entries = [entry("a", 1, 10 * MB, true), entry("b", 2, 10 * MB, true)];

        expect(choosePrefetchEvictions(entries, { wanted: [], playing: "b", capBytes: 100 * MB })).toEqual(["a"]);
    });

    it("drops songs the lookahead no longer wants, oldest first", () => {
        const entries = [entry("late", 5), entry("early", 1), entry("kept", 3)];

        expect(choosePrefetchEvictions(entries, { wanted: ["kept"], playing: undefined, capBytes: 100 * MB }))
            .toEqual(["early", "late"]);
    });

    it("never evicts the playing song, even when it alone is over the cap", () => {
        const entries = [entry("huge", 1, 150 * MB, true)];

        expect(choosePrefetchEvictions(entries, { wanted: [], playing: "huge", capBytes: 100 * MB })).toEqual([]);
    });

    it("over the cap, evicts the lined-up song furthest away, not the next one", () => {
        // "next" is oldest; evicting it to make room for "after" would make the prefetcher fetch "next" again.
        const entries = [entry("playing", 1, 40 * MB, true), entry("next", 2, 40 * MB), entry("after", 3, 40 * MB)];

        expect(choosePrefetchEvictions(entries, { wanted: ["next", "after"], playing: "playing", capBytes: 100 * MB }))
            .toEqual(["after"]);
    });

    it("evicts as many from the back as it takes to fit", () => {
        const entries = [entry("one", 1, 60 * MB), entry("two", 2, 30 * MB), entry("three", 3, 30 * MB)];

        expect(choosePrefetchEvictions(entries, { wanted: ["one", "two", "three"], playing: undefined, capBytes: 70 * MB }))
            .toEqual(["three", "two"]);
    });

    it("never leaves more than the cap behind, playing song aside", () => {
        const entries = Array.from({ length: 20 }, (_, i) => entry(`s${i}`, i, 9 * MB));
        const wanted = entries.map(e => e.songId);
        const evicted = choosePrefetchEvictions(entries, { wanted, playing: undefined, capBytes: PREFETCH_CACHE_CAP_BYTES });
        const left = entries.filter(e => !evicted.includes(e.songId)).reduce((sum, e) => sum + e.bytes, 0);

        expect(left).toBeLessThanOrEqual(PREFETCH_CACHE_CAP_BYTES);
        // And it kept the front of the lookahead.
        expect(evicted).not.toContain("s0");
    });

    it("caps at about 100 MB", () => {
        expect(PREFETCH_CACHE_CAP_BYTES).toBe(100 * MB);
    });
});

describe("prefetch setting", () => {
    it("is on unless it was turned off, mobile data included", () => {
        expect(parsePrefetchSetting(null)).toBe(true);
        expect(parsePrefetchSetting(undefined)).toBe(true);
        expect(parsePrefetchSetting("1")).toBe(true);
        expect(parsePrefetchSetting("0")).toBe(false);
    });
});
