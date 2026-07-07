import { LikeStatus } from "@/app/enums";

// A positive sentiment (Like or Love) on an un-vetted audition song is the "keep" signal that promotes it:
// the app enqueues a re-tag, which the server fulfils by enriching the song and clearing its exploratory
// flag. Neutral/Dislike never promotes (Dislike is "never play again"). Pure so it can be unit-tested.
export function shouldPromoteExploratory(exploratory: boolean, likeStatus: LikeStatus): boolean {
    return exploratory && (likeStatus === LikeStatus.Like || likeStatus === LikeStatus.Love);
}
