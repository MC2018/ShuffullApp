import { describe, expect, it } from "vitest";
import { namedRows } from "@/app/services/db/queries/_rawRow";

type Row = { songId: string; lastPlayed?: number };

/**
 * The two SQLite drivers return raw-`sql` results in different shapes, and reading a field off the wrong one
 * yields `undefined` rather than throwing. That silence is the whole danger: the desktop Play button pulled a
 * song id of `undefined` out of a 237-row pool and simply did nothing.
 */
describe("namedRows", () => {
    it("maps positional arrays (sqlite-proxy / web) onto column names", () => {
        const rows = namedRows<Row>([["s1", 123], ["s2", null]], ["songId", "lastPlayed"]);
        expect(rows).toEqual([
            { songId: "s1", lastPlayed: 123 },
            { songId: "s2", lastPlayed: null },
        ]);
        // The property actually resolves — the failure mode was a silent undefined.
        expect(rows[0].songId).toBe("s1");
    });

    it("passes row objects (expo-sqlite / mobile) through untouched", () => {
        const original = [{ songId: "s1", lastPlayed: 5 }];
        expect(namedRows<Row>(original, ["songId", "lastPlayed"])).toEqual(original);
    });

    it("handles an empty result", () => {
        expect(namedRows<Row>([], ["songId", "lastPlayed"])).toEqual([]);
    });

    it("leaves columns the row doesn't reach as undefined rather than shifting them", () => {
        const rows = namedRows<Row>([["s1"]], ["songId", "lastPlayed"]);
        expect(rows[0].songId).toBe("s1");
        expect(rows[0].lastPlayed).toBeUndefined();
    });

    it("both shapes produce the same result for the same data", () => {
        const fromArray = namedRows<Row>([["s1", 7]], ["songId", "lastPlayed"]);
        const fromObject = namedRows<Row>([{ songId: "s1", lastPlayed: 7 }], ["songId", "lastPlayed"]);
        expect(fromArray).toEqual(fromObject);
    });
});
