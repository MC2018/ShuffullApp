/**
 * Which song to play next, given the candidate pool.
 *
 * The pool arrives ordered by last_played ASCENDING (never-played first, then longest-ago), so the song that
 * just finished is at the very END. Selection therefore takes a WINDOW off the front:
 *
 *   - if there are never-played songs, the window is exactly those (hear new music first);
 *   - otherwise it is the least-recently-played 30%.
 *
 * The window is what stops repeats: it can never reach the tail, so the song that just played is not a
 * candidate for the next one. Extracted from mediaManager so that property is testable - mediaManager imports
 * react-native-track-player and cannot be loaded in a unit test.
 */

/** Fraction of the pool considered when everything has been played at least once. */
const LEAST_RECENTLY_PLAYED_FRACTION = 0.3;

/** A candidate as returned by getFilteredSong: id plus when the user last played it (null = never). */
export interface ShuffleCandidate {
    songId: string;
    lastPlayed?: number | Date | null;
}

/**
 * "Never played" exactly as the pool query defines it. The server seeds every UserSong with DateTime.MinValue,
 * which arrives as a large NEGATIVE epoch, so `<= 0` -- not null-ness -- is what separates never from ever; a
 * missing row (null) counts as never too.
 *
 * These two definitions used to disagree: this module tested `lastPlayed != null`, so an epoch-seeded row read
 * as PLAYED while the SQL counted it as never. That was harmless only while missing rows were rare. Once the
 * server deleted a batch of UserSongs, the ONLY nulls left were exactly those songs, and the never-played
 * window collapsed onto them -- every pick came from the deleted set.
 */
function hasBeenPlayed(candidate: ShuffleCandidate): boolean {
    const lastPlayed = candidate.lastPlayed;
    if (lastPlayed == null) {
        return false;
    }

    return (lastPlayed instanceof Date ? lastPlayed.getTime() : lastPlayed) > 0;
}

/**
 * Size of the selection window, in items off the front of the pool. Always at least 1 (so a pool of any size
 * yields something) and never the whole pool once anything has been played (so the just-played tail is
 * excluded).
 */
export function shuffleWindowSize(candidates: readonly ShuffleCandidate[]): number {
    if (candidates.length === 0) {
        return 0;
    }

    // The pool is ordered never-played first, so the index of the first PLAYED song is exactly how many have
    // never been played. findIndex returns -1 when it finds none - meaning nothing has been played at all, so
    // every song is a never-played one. (The old inline code wrote `?? 0` here, which does not catch -1 at all
    // since -1 is not nullish; it only survived because Math.max discarded the value.)
    const firstPlayedIndex = candidates.findIndex(hasBeenPlayed);
    const anythingPlayed = firstPlayedIndex !== -1;
    const neverPlayedCount = anythingPlayed ? firstPlayedIndex : candidates.length;

    const fractional = Math.floor(candidates.length * LEAST_RECENTLY_PLAYED_FRACTION);
    const window = Math.max(fractional, neverPlayedCount, 1);

    if (!anythingPlayed) {
        // Nothing has finished yet, so there is no just-played song to avoid: the whole pool is fair game.
        return window;
    }

    // Otherwise keep the window off the tail, which is the most recently played song - including it is exactly
    // how a song repeats itself. The lower bound of 1 matters for a single-song pool, where excluding the tail
    // would leave nothing at all; there the only honest answer is to replay it.
    return Math.max(1, Math.min(window, candidates.length - 1));
}

/**
 * Picks the next song. `random` is injectable so the choice can be pinned in tests; it must behave like
 * Math.random (0 inclusive, 1 exclusive).
 */
export function selectNextSong(
    candidates: readonly ShuffleCandidate[],
    random: () => number = Math.random,
): string | undefined {
    const window = shuffleWindowSize(candidates);
    if (window === 0) {
        return undefined;
    }

    // Clamped rather than trusted: a random() of exactly 1 (or a sloppy stub) would otherwise index past the
    // window and, at the extreme, hand back the song that just played.
    const index = Math.min(window - 1, Math.max(0, Math.floor(random() * window)));
    return candidates[index]?.songId;
}
