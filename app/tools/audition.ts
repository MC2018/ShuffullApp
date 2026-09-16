import { LikeStatus } from "@/app/enums";

// The visual state of a song row inside an AUDITION playlist, derived entirely from data that already
// syncs (so it is identical across devices):
//   unheard — still exploratory, never played, no verdict: gets the accent dot (needs its chance).
//   heard   — played (or explicitly disliked) but not retained: dimmed, it dies with the cohort purge.
//   kept    — retained via the Keep button (left the audition state without a like): bookmark glyph.
//   liked   — retained via Like/Love: heart glyph.
// "Played" = lastPlayed after the epoch: server-seeded rows carry DateTime.MinValue (far before 1970),
// while every real play stamps a current time, so the epoch cleanly splits "never" from "ever".
export type AuditionRowState = "unheard" | "heard" | "kept" | "liked";

export function hasBeenPlayed(lastPlayed: Date | null | undefined): boolean {
    return lastPlayed != null && lastPlayed.getTime() > 0;
}

/**
 * `isAuditionPlaylist` is what makes the "kept" inference valid.
 *
 * INSIDE an audition playlist, a song that is no longer exploratory and was not liked must have been retained
 * with the Keep button - that is the only other way out of the audition state. OUTSIDE one the same test says
 * nothing: songs in an ordinary playlist were never exploratory to begin with, so treating them all as "kept"
 * marked every row in Classic Rock or YouTube Liked as evaluated and left "Unheard only" matching nothing at
 * all. Heard-vs-unheard is perfectly meaningful there; only the Keep shortcut is not.
 */
export function deriveAuditionRowState(
    exploratory: boolean,
    likeStatus: LikeStatus,
    lastPlayed: Date | null | undefined,
    isAuditionPlaylist: boolean = true,
): AuditionRowState {
    if (likeStatus === LikeStatus.Like || likeStatus === LikeStatus.Love) {
        return "liked";
    }
    if (likeStatus === LikeStatus.Dislike) {
        return "heard"; // an explicit reject is a verdict — it counts as evaluated, and it dims
    }
    if (isAuditionPlaylist && !exploratory) {
        return "kept"; // left the audition state without a like ⇒ the Keep button did it
    }
    return hasBeenPlayed(lastPlayed) ? "heard" : "unheard";
}

// Cohort progress for the library bubble: evaluated = everything that has had its chance (anything but
// unheard). Rendered as "12/50"; complete (and safe to delete) when evaluated === total.
export function auditionProgress(states: AuditionRowState[]): { evaluated: number; total: number } {
    return {
        evaluated: states.filter(s => s !== "unheard").length,
        total: states.length,
    };
}
