import { describe, it, expect } from "vitest";
import { hasDisplayableLyrics } from "@/app/tools/lrc";

/**
 * Whether the Now Playing screen offers a lyrics toggle at all.
 *
 * The rule that matters: an INSTRUMENTAL song must not. The flag is worth keeping in the data - it is how the
 * producer knows a track has no lyrics by design and stops re-querying providers forever - but as UI it only
 * ever rendered "♪ Instrumental ♪", a lyrics panel whose whole message is that there are no lyrics.
 */
describe("lyrics visibility", () => {
    it("shows lyrics when there are synced lyrics", () => {
        expect(hasDisplayableLyrics({ syncedLyrics: "[00:12.34]hello", plainLyrics: null })).toBe(true);
    });

    it("shows lyrics when there are plain lyrics", () => {
        expect(hasDisplayableLyrics({ syncedLyrics: null, plainLyrics: "hello there" })).toBe(true);
    });

    it("does NOT show a lyrics UI for an instrumental song", () => {
        // The reported complaint: a panel that exists only to say there is nothing to show.
        expect(hasDisplayableLyrics({ syncedLyrics: null, plainLyrics: null, lyricsInstrumental: true } as never)).toBe(false);
    });

    it("does not show a lyrics UI when there is nothing at all", () => {
        expect(hasDisplayableLyrics({ syncedLyrics: null, plainLyrics: null })).toBe(false);
        expect(hasDisplayableLyrics(null)).toBe(false);
        expect(hasDisplayableLyrics(undefined)).toBe(false);
    });

    it("treats empty strings as absent", () => {
        // A cleared payload must read the same as a missing one, or purged lyrics would leave a dead toggle.
        expect(hasDisplayableLyrics({ syncedLyrics: "", plainLyrics: "" })).toBe(false);
    });

    it("still shows lyrics for an instrumental-flagged song that DOES have lyrics", () => {
        // Defensive: the flag and real content can disagree (a provider mislabels, or lyrics arrive later).
        // Real content wins - hiding it would lose something the user can actually read.
        expect(hasDisplayableLyrics({ syncedLyrics: "[00:01.00]not really instrumental", plainLyrics: null, lyricsInstrumental: true } as never)).toBe(true);
    });
});
