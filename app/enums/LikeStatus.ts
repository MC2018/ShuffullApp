// Mirrors the SITE's Shuffull.Core.Models.Enums.LikeStatus. Dislike means "never play again" — the app
// excludes disliked songs from the shuffle/random-selection path (explicit play is still allowed).
export enum LikeStatus {
    Neutral = 0,
    Like = 1,
    Love = 2,
    Dislike = 3,
}
