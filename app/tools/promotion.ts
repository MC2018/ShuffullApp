import { LikeStatus } from "@/app/enums";

// A positive sentiment (Like or Love) is the "keep" signal that promotes a song whose tags are below the
// server's current strong model: an un-vetted audition song (exploratory, no tags at all) or a weak-tagged
// one (tagsStale, e.g. imported at the Standard tier). The app enqueues a re-tag, which the server fulfils
// by enriching the song with the strong model and clearing the flags. Neutral/Dislike never promotes
// (Dislike is "never play again"). Pure so it can be unit-tested.
export function shouldPromoteOnLike(exploratory: boolean, tagsStale: boolean, likeStatus: LikeStatus): boolean {
    return (exploratory || tagsStale) && (likeStatus === LikeStatus.Like || likeStatus === LikeStatus.Love);
}
