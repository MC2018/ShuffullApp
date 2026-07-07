import { describe, it, expect } from "vitest";
import { LikeStatus } from "@/app/enums";
import { shouldPromoteExploratory } from "@/app/tools/promotion";

// The "keep" rule that drives promote-on-like: a positive sentiment on an audition song enqueues a re-tag.
describe("shouldPromoteExploratory", () => {
    it("promotes an audition song on Like or Love", () => {
        expect(shouldPromoteExploratory(true, LikeStatus.Like)).toBe(true);
        expect(shouldPromoteExploratory(true, LikeStatus.Love)).toBe(true);
    });

    it("does not promote on Neutral or Dislike", () => {
        expect(shouldPromoteExploratory(true, LikeStatus.Neutral)).toBe(false);
        expect(shouldPromoteExploratory(true, LikeStatus.Dislike)).toBe(false);
    });

    it("never promotes a non-audition song", () => {
        expect(shouldPromoteExploratory(false, LikeStatus.Like)).toBe(false);
        expect(shouldPromoteExploratory(false, LikeStatus.Love)).toBe(false);
        expect(shouldPromoteExploratory(false, LikeStatus.Neutral)).toBe(false);
    });
});
