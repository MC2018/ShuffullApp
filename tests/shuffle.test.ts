import { describe, it, expect } from "vitest";
import { selectNextSong, shuffleWindowSize, type ShuffleCandidate } from "@/app/tools/shuffle";

/**
 * The system's core promise is "don't play the same song twice in a row". Selection gets a pool ordered by
 * last_played ASC - never-played first, longest-ago next, and the song that JUST finished last - and takes a
 * window off the front. The invariant that matters is therefore simply: the window never reaches the tail.
 *
 * These are exhaustive rather than illustrative. A shuffle bug shows up as one unlucky repeat in a listening
 * session, which is close to impossible to reproduce by hand.
 */

/** A pool of `played` already-played songs preceded by `unplayed` never-played ones, in real query order. */
function pool(unplayed: number, played: number): ShuffleCandidate[] {
    const candidates: ShuffleCandidate[] = [];
    for (let i = 0; i < unplayed; i++) {
        candidates.push({ songId: `new-${i}`, lastPlayed: null });
    }
    // Oldest first, so the LAST entry is the most recently played - the song that just finished.
    for (let i = 0; i < played; i++) {
        candidates.push({ songId: `played-${i}`, lastPlayed: 1_000 + i });
    }
    return candidates;
}

describe("shuffle window", () => {
    it("is empty only for an empty pool", () => {
        expect(shuffleWindowSize([])).toBe(0);
        expect(selectNextSong([])).toBeUndefined();
    });

    it("always yields a song when the pool is non-empty", () => {
        for (let n = 1; n <= 200; n++) {
            expect(selectNextSong(pool(0, n))).toBeDefined();
            expect(selectNextSong(pool(n, 0))).toBeDefined();
        }
    });

    it("never selects the most recently played song", () => {
        // The whole point. Swept across pool shapes AND the full range of random(), because a repeat only needs
        // one unlucky draw.
        for (let played = 2; played <= 120; played++) {
            for (const unplayed of [0, 1, 5, played]) {
                const candidates = pool(unplayed, played);
                const justPlayed = candidates[candidates.length - 1].songId;

                for (let r = 0; r < 1; r += 0.01) {
                    expect(selectNextSong(candidates, () => r)).not.toBe(justPlayed);
                }
                // and the degenerate stubs
                expect(selectNextSong(candidates, () => 0)).not.toBe(justPlayed);
                expect(selectNextSong(candidates, () => 0.999999)).not.toBe(justPlayed);
            }
        }
    });

    it("stays in range even for a random() that misbehaves", () => {
        const candidates = pool(3, 20);
        for (const r of [0, 0.5, 0.999999, 1, 1.5, -0.5, Number.EPSILON]) {
            const picked = selectNextSong(candidates, () => r);
            expect(candidates.map((c) => c.songId)).toContain(picked);
        }
    });

    it("prefers never-played songs while any remain", () => {
        // 40 unplayed out of 100: every pick should be a new song, not a re-listen.
        const candidates = pool(40, 60);
        for (let r = 0; r < 1; r += 0.01) {
            expect(selectNextSong(candidates, () => r)!.startsWith("new-")).toBe(true);
        }
    });

    it("falls back to the least-recently-played end once everything has been heard", () => {
        const candidates = pool(0, 100);
        const window = shuffleWindowSize(candidates);

        expect(window).toBe(30);   // 30% of 100
        for (let r = 0; r < 1; r += 0.01) {
            const picked = selectNextSong(candidates, () => r)!;
            const index = candidates.findIndex((c) => c.songId === picked);
            expect(index).toBeLessThan(30);
        }
    });

    it("handles a single-song pool without crashing", () => {
        // Nothing else can be chosen; the caller replays it rather than stopping.
        expect(selectNextSong(pool(0, 1))).toBe("played-0");
        expect(selectNextSong(pool(1, 0))).toBe("new-0");
    });

    it("still has choice in a tiny fully-played pool", () => {
        // A 3-song playlist must not collapse onto one index forever. (The old inline maths used an unfloored
        // 0.3*3 = 0.9 window, so Math.floor(0.9 * r) was ALWAYS 0.)
        const candidates = pool(0, 3);
        expect(shuffleWindowSize(candidates)).toBeGreaterThanOrEqual(1);
        expect(shuffleWindowSize(candidates)).toBeLessThanOrEqual(2);   // never the just-played tail
        expect(selectNextSong(candidates, () => 0)).not.toBe("played-2");
        expect(selectNextSong(candidates, () => 0.99)).not.toBe("played-2");
    });

    it("treats an all-played pool as fully played (findIndex -1 is not a window size)", () => {
        // findIndex returns -1 when nothing is unplayed; reading that as a count would be nonsense. The old code
        // used `?? 0`, which does not catch -1 - it only survived because Math.max discarded it.
        const candidates = pool(0, 10);
        expect(shuffleWindowSize(candidates)).toBe(3);
    });

    it("uses the whole pool only while nothing has been played", () => {
        // No song has finished yet, so there is no "just played" one to avoid.
        expect(shuffleWindowSize(pool(10, 0))).toBe(10);
    });

    it("cycles through a small playlist instead of repeating", () => {
        // Simulate real playback: pick, then move that song to the tail (its last_played becomes newest).
        // Over many rounds the same song must never come up twice consecutively.
        let candidates = pool(0, 8);
        let previous: string | undefined;

        for (let round = 0; round < 500; round++) {
            const picked = selectNextSong(candidates, () => (round * 0.37) % 1)!;
            expect(picked).not.toBe(previous);

            previous = picked;
            const rest = candidates.filter((c) => c.songId !== picked);
            candidates = [...rest, { songId: picked, lastPlayed: 100_000 + round }];
        }
    });

    it("never repeats across a long session on a large playlist", () => {
        // The reported failure: hundreds of songs, one repeat. 5000 rounds with real randomness.
        let candidates = pool(0, 300);
        let previous: string | undefined;

        for (let round = 0; round < 5_000; round++) {
            const picked = selectNextSong(candidates)!;
            expect(picked).not.toBe(previous);

            previous = picked;
            const rest = candidates.filter((c) => c.songId !== picked);
            candidates = [...rest, { songId: picked, lastPlayed: 100_000 + round }];
        }
    });
});
