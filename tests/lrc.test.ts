import { describe, it, expect } from "vitest";
import { parseLrc, activeLineIndex, type LrcLine } from "@/app/tools/lrc";

describe("parseLrc", () => {
    it("parses mm:ss.xx timestamps into milliseconds", () => {
        const lines = parseLrc("[00:12.50]hello\n[01:05.00]world");
        expect(lines).toEqual<LrcLine[]>([
            { timeMs: 12500, text: "hello" },
            { timeMs: 65000, text: "world" },
        ]);
    });

    it("accepts a colon as the fraction separator", () => {
        const lines = parseLrc("[00:01:25]tick");
        // 0.25 of a second -> 250ms
        expect(lines).toEqual([{ timeMs: 1250, text: "tick" }]);
    });

    it("supports three-digit (millisecond) fractions", () => {
        const lines = parseLrc("[00:00.123]ms");
        expect(lines).toEqual([{ timeMs: 123, text: "ms" }]);
    });

    it("treats a timestamp with no fraction as a whole second", () => {
        const lines = parseLrc("[02:03]no frac");
        expect(lines).toEqual([{ timeMs: 123000, text: "no frac" }]);
    });

    it("expands multiple leading timestamps on one line (e.g. a repeated chorus)", () => {
        const lines = parseLrc("[00:01.00][00:10.00]chorus");
        expect(lines).toEqual([
            { timeMs: 1000, text: "chorus" },
            { timeMs: 10000, text: "chorus" },
        ]);
    });

    it("sorts the output by time even when input is out of order", () => {
        const lines = parseLrc("[00:10.00]b\n[00:01.00]a");
        expect(lines.map(l => l.text)).toEqual(["a", "b"]);
    });

    it("ignores non-time metadata tags and lines with no leading timestamp", () => {
        const lines = parseLrc("[ar:Artist]\n[ti:Title]\nplain line\n[00:05.00]real");
        expect(lines).toEqual([{ timeMs: 5000, text: "real" }]);
    });

    it("keeps a stray mid-line bracket as part of the text", () => {
        const lines = parseLrc("[00:05.00]say [00:06.00] now");
        expect(lines).toEqual([{ timeMs: 5000, text: "say [00:06.00] now" }]);
    });

    it("trims surrounding whitespace from the line text", () => {
        const lines = parseLrc("[00:05.00]   spaced   ");
        expect(lines).toEqual([{ timeMs: 5000, text: "spaced" }]);
    });

    it("preserves empty lyric text (instrumental gaps)", () => {
        const lines = parseLrc("[00:05.00]");
        expect(lines).toEqual([{ timeMs: 5000, text: "" }]);
    });

    it("handles CRLF line endings", () => {
        const lines = parseLrc("[00:01.00]a\r\n[00:02.00]b");
        expect(lines.map(l => l.text)).toEqual(["a", "b"]);
    });

    it("returns an empty array for empty or tag-only input", () => {
        expect(parseLrc("")).toEqual([]);
        expect(parseLrc("[ar:Only]\n[ti:Tags]")).toEqual([]);
    });
});

describe("activeLineIndex", () => {
    const lines: LrcLine[] = [
        { timeMs: 1000, text: "a" },
        { timeMs: 2000, text: "b" },
        { timeMs: 3000, text: "c" },
    ];

    it("returns -1 before the first line", () => {
        expect(activeLineIndex(lines, 0)).toBe(-1);
        expect(activeLineIndex(lines, 999)).toBe(-1);
    });

    it("returns the line whose timestamp is exactly the position", () => {
        expect(activeLineIndex(lines, 1000)).toBe(0);
        expect(activeLineIndex(lines, 2000)).toBe(1);
    });

    it("returns the last line whose timestamp is <= the position", () => {
        expect(activeLineIndex(lines, 1500)).toBe(0);
        expect(activeLineIndex(lines, 2999)).toBe(1);
    });

    it("returns the final line once past the last timestamp", () => {
        expect(activeLineIndex(lines, 10000)).toBe(2);
    });

    it("returns -1 for an empty line list", () => {
        expect(activeLineIndex([], 1234)).toBe(-1);
    });
});
