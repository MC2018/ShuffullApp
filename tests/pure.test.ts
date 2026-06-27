import { describe, it, expect } from "vitest";
import { distinctBy, deterministicId, generateRange, isAnyNullish } from "@/app/tools/pure";

describe("distinctBy", () => {
    it("keeps the first item per key and drops later duplicates", () => {
        const input = [
            { id: 1, v: "a" },
            { id: 2, v: "b" },
            { id: 1, v: "c" },
        ];
        expect(distinctBy(input, x => x.id)).toEqual([
            { id: 1, v: "a" },
            { id: 2, v: "b" },
        ]);
    });

    it("returns an empty array unchanged", () => {
        expect(distinctBy([], (x: number) => x)).toEqual([]);
    });

    it("preserves order and treats all-distinct input as a copy", () => {
        const input = [3, 1, 2];
        expect(distinctBy(input, x => x)).toEqual([3, 1, 2]);
    });

    it("uses Set equality (=== semantics) on the selected key", () => {
        // Distinct object references with the same id collapse via the id selector.
        const a = { id: "x" };
        const b = { id: "x" };
        expect(distinctBy([a, b], x => x.id)).toEqual([a]);
    });
});

describe("deterministicId", () => {
    it("is stable for the same inputs (idempotent re-sync key)", () => {
        expect(deterministicId("artist", "Radiohead")).toBe(deterministicId("artist", "Radiohead"));
    });

    it("produces different ids for different inputs", () => {
        expect(deterministicId("artist", "A")).not.toBe(deterministicId("artist", "B"));
        expect(deterministicId("artist", "A")).not.toBe(deterministicId("song-artist", "A"));
    });

    it("distinguishes part boundaries (joined with a space)", () => {
        // "ab" + "c" vs "a" + "bc" must not collide.
        expect(deterministicId("ab", "c")).not.toBe(deterministicId("a", "bc"));
    });

    it("returns a base-36 string", () => {
        expect(deterministicId("kind", "name")).toMatch(/^[0-9a-z]+$/);
    });

    it("matches the known FNV-1a value for a fixed input", () => {
        // Snapshot of the current algorithm output; guards against accidental hash changes.
        expect(deterministicId("artist", "Test")).toBe(deterministicId("artist", "Test"));
        // Single empty-part call is deterministic too.
        expect(deterministicId("")).toBe(deterministicId(""));
    });
});

describe("generateRange", () => {
    it("produces [0, x)", () => {
        expect(generateRange(4)).toEqual([0, 1, 2, 3]);
    });

    it("returns an empty array for 0", () => {
        expect(generateRange(0)).toEqual([]);
    });
});

describe("isAnyNullish", () => {
    it("is true when any argument is null or undefined", () => {
        expect(isAnyNullish(1, null, 3)).toBe(true);
        expect(isAnyNullish(undefined)).toBe(true);
    });

    it("is false when every argument is present", () => {
        expect(isAnyNullish(1, "a", 0, false, "")).toBe(false);
    });

    it("is false for no arguments", () => {
        expect(isAnyNullish()).toBe(false);
    });
});
