import { describe, it, expect } from "vitest";
import { LikeStatus } from "@/app/enums";
import { auditionProgress, deriveAuditionRowState, hasBeenPlayed } from "@/app/tools/audition";

// The four-state row derivation for audition playlists, computed entirely from synced fields so it is
// identical across devices: unheard (dot) / heard incl. disliked (dimmed) / kept (bookmark) / liked (heart).
describe("deriveAuditionRowState", () => {
    const played = new Date("2026-07-20T12:00:00Z");

    it("likes and loves render as liked, regardless of anything else", () => {
        expect(deriveAuditionRowState(true, LikeStatus.Like, null)).toBe("liked");
        expect(deriveAuditionRowState(false, LikeStatus.Love, played)).toBe("liked");
    });

    it("a dislike is a verdict: heard (dimmed), even at zero seconds played", () => {
        expect(deriveAuditionRowState(true, LikeStatus.Dislike, null)).toBe("heard");
    });

    it("a non-exploratory undecided song in an audition view was Kept", () => {
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, played)).toBe("kept");
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, null)).toBe("kept");
    });

    it("an exploratory song splits on whether it has ever been played", () => {
        expect(deriveAuditionRowState(true, LikeStatus.Neutral, played)).toBe("heard");
        expect(deriveAuditionRowState(true, LikeStatus.Neutral, null)).toBe("unheard");
    });

    it("server-seeded DateTime.MinValue lastPlayed does not count as played", () => {
        // The site seeds UserSong.LastPlayed = DateTime.MinValue (year 1), far before the epoch.
        const minValue = new Date(-62135596800000);
        expect(hasBeenPlayed(minValue)).toBe(false);
        expect(deriveAuditionRowState(true, LikeStatus.Neutral, minValue)).toBe("unheard");
    });
});

describe("auditionProgress", () => {
    it("counts everything but unheard as evaluated", () => {
        const progress = auditionProgress(["unheard", "heard", "kept", "liked", "unheard"]);
        expect(progress).toEqual({ evaluated: 3, total: 5 });
    });

    it("empty cohort is 0/0", () => {
        expect(auditionProgress([])).toEqual({ evaluated: 0, total: 0 });
    });
});
