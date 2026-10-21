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
export function auditionProgress(states: AuditionRowState[]): AuditionProgress {
    return {
        evaluated: states.filter(s => s !== "unheard").length,
        total: states.length,
    };
}

export type AuditionProgress = { evaluated: number; total: number };

/** Every song in the cohort has had its chance. An empty cohort is never "complete": there was nothing to hear. */
export function isAuditionComplete(progress: AuditionProgress | undefined): boolean {
    return progress != undefined && progress.total > 0 && progress.evaluated === progress.total;
}

/**
 * The audition playlist a playback scope is working through, or undefined for any other scope.
 *
 * `unheardOnly` is set only by the audition play paths, and always together with a sole playlist filter, so the
 * pair identifies an audition session. Ordinary playlists, artists, jams and whole-library shuffle never set it,
 * which is what keeps the stop-when-done rule below away from them.
 */
export type AuditionScope = { unheardOnly: boolean; whitelists: { playlistIds: string[] } };

export function auditionScopePlaylistId(scope: AuditionScope): string | undefined {
    const playlistIds = scope.whitelists.playlistIds ?? [];
    return scope.unheardOnly && playlistIds.length === 1 ? playlistIds[0] : undefined;
}

/**
 * Whether moving on from the current song should stop playback instead, because the audition just finished.
 *
 * `inProgressPlaylistId` is the audition that still had unheard songs when the current song STARTED (undefined if
 * it was already complete, or the song wasn't in one). Requiring that is what makes this fire once, on the
 * transition: a mix the user goes on playing after it finished, or opens again once complete, plays on as usual.
 * `scopePlaylistId` is the audition the player is scoped to now, so switching to another list in between never
 * stops on the old mix's account.
 */
export function shouldStopForFinishedAudition(
    inProgressPlaylistId: string | undefined,
    scopePlaylistId: string | undefined,
    progressNow: AuditionProgress | undefined,
): boolean {
    return inProgressPlaylistId != undefined
        && inProgressPlaylistId === scopePlaylistId
        && isAuditionComplete(progressNow);
}
