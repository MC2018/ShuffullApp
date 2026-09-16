import { describe, it, expect } from "vitest";
import { LikeStatus } from "@/app/enums";
import { shouldPromoteOnLike, shouldSkipOnDislike } from "@/app/tools/promotion";

// The "keep" rule that drives promote-on-like: a positive sentiment on an audition (exploratory) song or a
// weak-tagged (tagsStale) song enqueues a re-tag that upgrades it with the strong model.
describe("shouldPromoteOnLike", () => {
    it("promotes an audition song on Like or Love", () => {
        expect(shouldPromoteOnLike(true, false, LikeStatus.Like)).toBe(true);
        expect(shouldPromoteOnLike(true, false, LikeStatus.Love)).toBe(true);
    });

    it("promotes a weak-tagged song on Like or Love", () => {
        expect(shouldPromoteOnLike(false, true, LikeStatus.Like)).toBe(true);
        expect(shouldPromoteOnLike(false, true, LikeStatus.Love)).toBe(true);
    });

    it("does not promote on Neutral or Dislike", () => {
        expect(shouldPromoteOnLike(true, false, LikeStatus.Neutral)).toBe(false);
        expect(shouldPromoteOnLike(true, false, LikeStatus.Dislike)).toBe(false);
        expect(shouldPromoteOnLike(false, true, LikeStatus.Neutral)).toBe(false);
        expect(shouldPromoteOnLike(false, true, LikeStatus.Dislike)).toBe(false);
    });

    it("never promotes a song that is neither audition nor weak-tagged", () => {
        expect(shouldPromoteOnLike(false, false, LikeStatus.Like)).toBe(false);
        expect(shouldPromoteOnLike(false, false, LikeStatus.Love)).toBe(false);
        expect(shouldPromoteOnLike(false, false, LikeStatus.Neutral)).toBe(false);
    });
});

// "Dislike means never play again" applied to the song currently in your ears, not just to future shuffles.
describe("shouldSkipOnDislike", () => {
    it("skips when the playing song is disliked", () => {
        expect(shouldSkipOnDislike(true, LikeStatus.Dislike, true)).toBe(true);
    });

    // The regression that matters most: RatingControl renders per row, so disliking something in a list must
    // leave playback completely alone.
    it("never skips when the disliked song is not the active one", () => {
        expect(shouldSkipOnDislike(false, LikeStatus.Dislike, true)).toBe(false);
    });

    // skip() starts the next song, so acting while paused would begin playing audio unprompted.
    it("does not skip while paused", () => {
        expect(shouldSkipOnDislike(true, LikeStatus.Dislike, false)).toBe(false);
    });

    // Un-disliking passes Neutral. Nothing but the transition INTO Dislike may move the queue.
    it("does not skip for any other rating", () => {
        for (const status of [LikeStatus.Neutral, LikeStatus.Like, LikeStatus.Love]) {
            expect(shouldSkipOnDislike(true, status, true)).toBe(false);
        }
    });
});
