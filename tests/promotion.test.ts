import { describe, it, expect } from "vitest";
import { LikeStatus } from "@/app/enums";
import { shouldPromoteOnLike } from "@/app/tools/promotion";

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
