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

export function deriveAuditionRowState(
    exploratory: boolean,
    likeStatus: LikeStatus,
    lastPlayed: Date | null | undefined,
): AuditionRowState {
    if (likeStatus === LikeStatus.Like || likeStatus === LikeStatus.Love) {
        return "liked";
    }
    if (likeStatus === LikeStatus.Dislike) {
        return "heard"; // an explicit reject is a verdict — it counts as evaluated, and it dims
    }
    if (!exploratory) {
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
