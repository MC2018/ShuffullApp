import { describe, it, expect } from "vitest";
import { computeTapBpm, nextTaps, TAP_STALE_MS } from "@/app/tools/tapTempo";

describe("computeTapBpm", () => {
    it("returns null with fewer than two taps", () => {
        expect(computeTapBpm([])).toBeNull();
        expect(computeTapBpm([1000])).toBeNull();
    });

    it("computes 120 BPM from 500ms intervals", () => {
        expect(computeTapBpm([0, 500, 1000, 1500])).toBe(120);
    });

    it("computes ~174 BPM from drum & bass spacing", () => {
        // 174 BPM = ~344.8ms per beat
        expect(computeTapBpm([0, 345, 690, 1035])).toBe(174);
    });

    it("averages uneven taps", () => {
        // intervals 480 and 520 -> avg 500 -> 120
        expect(computeTapBpm([0, 480, 1000])).toBe(120);
    });

    it("returns null for an implausible tempo (taps too close)", () => {
        expect(computeTapBpm([0, 50])).toBeNull(); // 1200 BPM
    });
});

describe("nextTaps", () => {
    it("appends the first tap", () => {
        expect(nextTaps([], 1000)).toEqual([1000]);
    });

    it("appends within the stale window", () => {
        expect(nextTaps([1000], 1500)).toEqual([1000, 1500]);
    });

    it("restarts after a long pause", () => {
        expect(nextTaps([1000], 1000 + TAP_STALE_MS + 1)).toEqual([1000 + TAP_STALE_MS + 1]);
    });

    it("keeps only the last maxTaps", () => {
        const prev = [1, 2, 3, 4, 5, 6, 7, 8];
        expect(nextTaps(prev, 9, TAP_STALE_MS, 8)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    });
});
