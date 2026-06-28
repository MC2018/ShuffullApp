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

    it("accumulates every tap within the window (no cap)", () => {
        // A long run of taps all keeps growing — more taps = more accurate, no truncation.
        let taps: number[] = [];
        for (let i = 0; i < 40; i++) {
            taps = nextTaps(taps, i * 400); // 150 BPM spacing
        }
        expect(taps).toHaveLength(40);
        expect(computeTapBpm(taps)).toBe(150);
    });
});
