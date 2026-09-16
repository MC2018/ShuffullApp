import { describe, expect, it } from "vitest";
import { chunkIds, chunkRows } from "../app/services/db/queries/_chunk";

/**
 * These caps are what keep a bulk write inside SQLite's per-statement limits. A regression here is silent on
 * a small library and only shows up once someone's sync grows past the limit — which is exactly how the
 * desktop build shipped broken (a 1357-row / 6785-parameter insert died as "Error finalizing statement").
 */
describe("chunkRows", () => {
    const rows = (n: number, columns: number) =>
        Array.from({ length: n }, () =>
            Object.fromEntries(Array.from({ length: columns }, (_, c) => [`c${c}`, c])));

    it("returns nothing for an empty list", () => {
        expect(chunkRows([])).toEqual([]);
    });

    it("leaves a small batch as a single statement", () => {
        expect(chunkRows(rows(10, 5))).toHaveLength(1);
    });

    it("keeps every chunk under both the row and parameter caps", () => {
        for (const columns of [1, 3, 5, 12, 40]) {
            for (const chunk of chunkRows(rows(5000, columns))) {
                expect(chunk.length).toBeLessThanOrEqual(250);
                expect(chunk.length * columns).toBeLessThanOrEqual(900);
            }
        }
    });

    it("preserves every row, in order", () => {
        const source = Array.from({ length: 1357 }, (_, i) => ({ a: i, b: i, c: i, d: i, e: i }));
        expect(chunkRows(source).flat()).toEqual(source);
    });

    it("sizes by the WIDEST row, so a sparse first row cannot under-count columns", () => {
        const mixed = [{ a: 1 }, ...Array.from({ length: 999 }, () => ({ a: 1, b: 2, c: 3, d: 4, e: 5 }))];
        for (const chunk of chunkRows(mixed)) {
            expect(chunk.length * 5).toBeLessThanOrEqual(900);
        }
    });

    it("still emits chunks when a single row is very wide", () => {
        const wide = chunkRows(rows(5, 2000));
        expect(wide.flat()).toHaveLength(5);
        expect(wide.every((c) => c.length >= 1)).toBe(true);
    });
});

describe("chunkIds", () => {
    it("returns nothing for an empty list", () => {
        expect(chunkIds([])).toEqual([]);
    });

    it("caps each chunk at the parameter limit and preserves order", () => {
        const ids = Array.from({ length: 2500 }, (_, i) => `id-${i}`);
        const chunks = chunkIds(ids);
        expect(chunks.every((c) => c.length <= 900)).toBe(true);
        expect(chunks.flat()).toEqual(ids);
    });
});
