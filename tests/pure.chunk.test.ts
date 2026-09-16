import { describe, expect, it } from "vitest";

import { chunk } from "../app/tools/pure";

describe("chunk", () => {
    it("splits evenly when the length is a multiple of the size", () => {
        expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    });

    it("leaves the remainder in a short final chunk", () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it("returns no chunks for an empty array", () => {
        expect(chunk([], 3)).toEqual([]);
    });

    it("rejects a size below 1", () => {
        expect(() => chunk([1], 0)).toThrow(/at least 1/);
    });
});
