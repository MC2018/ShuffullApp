import { LikeStatus } from "@/app/enums";

// A positive sentiment (Like or Love) is the "keep" signal that promotes a song whose tags are below the
// server's current strong model: an un-vetted audition song (exploratory, no tags at all) or a weak-tagged
// one (tagsStale, e.g. imported at the Standard tier). The app enqueues a re-tag, which the server fulfils
// by enriching the song with the strong model and clearing the flags. Neutral/Dislike never promotes
// (Dislike is "never play again"). Pure so it can be unit-tested.
export function shouldPromoteOnLike(exploratory: boolean, tagsStale: boolean, likeStatus: LikeStatus): boolean {
    return (exploratory || tagsStale) && (likeStatus === LikeStatus.Like || likeStatus === LikeStatus.Love);
}

/**
 * The other half of "Dislike means never play again": stop playing it NOW, rather than only from the next
 * shuffle onwards.
 *
 * Three conditions, each load-bearing:
 *
 * - `isActiveSong` — rating a row in a list must not disturb what is playing. RatingControl is rendered per
 *   row, so without this, thumbing down something in the library would yank the current song out from under
 *   the user.
 * - `likeStatus === Dislike` — this fires on the TRANSITION to disliked. Un-disliking passes Neutral, and a
 *   song already disliked before it started playing is not re-evaluated here.
 * - `isPlaying` — skip() starts the next song, so acting while paused would spontaneously begin playing audio
 *   the user never asked to hear. Disliking a paused song just leaves it rated.
 */
export function shouldSkipOnDislike(isActiveSong: boolean, likeStatus: LikeStatus, isPlaying: boolean): boolean {
    return isActiveSong && likeStatus === LikeStatus.Dislike && isPlaying;
}
