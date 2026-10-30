/**
 * The next few songs skip() will play, decided ahead of the skip so they can be fetched before it (ShuffullApp#124).
 *
 * skip() takes the queue first, then forward history (songs after the current one in recently-played, after a
 * previous()), and only then a shuffle pick. The first two are already decided: they are state, and the lookahead
 * just reads them. Only the shuffle pick used to be made at the moment of the skip, so it is the one thing this
 * module has to remember: `picks` are shuffle picks reserved for the slots the queue and history don't fill, and
 * skip() takes the first of them instead of shuffling fresh.
 *
 * A reserved pick is thrown away whenever it stops being what skip() would play:
 *   - the scope or filters change: `reset()`;
 *   - a reserved song is disliked: `forget()`;
 *   - the queue or forward history grows (addToQueue, previous()): `refresh()` gives them the front slots and drops
 *     the picks that no longer fit, from the back.
 *
 * Extracted from mediaManager so it is testable - mediaManager imports react-native-track-player and cannot be
 * loaded in a unit test.
 */

/** How many songs ahead are decided and fetched. */
export const LOOKAHEAD_SIZE = 2;

export interface LookaheadSource {
    /** The song playing now, if any. */
    current(): string | undefined;
    /** Songs the user queued, in play order. */
    queue(): readonly string[];
    /** Up to `limit` songs after the current one in recently-played history, in play order. */
    forwardHistory(limit: number): Promise<string[]>;
    /**
     * One shuffle pick, as skip() would make it once every song in `played` has played (they are about to, so they
     * belong at the back of the pool, not in the window at its front).
     */
    pick(played: readonly string[]): Promise<string | undefined>;
    /** Whether a reserved pick may still play: still in the current scope, still in the library. */
    isEligible(songId: string): Promise<boolean>;
}

export class Lookahead {
    private picks: string[] = [];
    // Bumped by every change to `picks` from outside refresh(). A refresh that started before one is stale: it read
    // the queue, history and picks as they were, so it must not write its answer back.
    private generation = 0;

    constructor(
        private readonly source: LookaheadSource,
        readonly size: number = LOOKAHEAD_SIZE,
    ) {}

    /** The shuffle picks reserved right now, in play order. */
    get reservedPicks(): readonly string[] {
        return this.picks;
    }

    /** Drops every reserved pick: the scope they were drawn from has changed. */
    reset(): void {
        this.picks = [];
        this.generation++;
    }

    /** Drops one reserved pick (it was disliked). Returns whether it was reserved, so the caller knows to refresh. */
    forget(songId: string): boolean {
        if (!this.picks.includes(songId)) {
            return false;
        }

        this.picks = this.picks.filter(id => id !== songId);
        this.generation++;
        return true;
    }

    /**
     * skip() reaching its shuffle step: the next reserved pick, if there is one and it may still play. Undefined
     * means "shuffle fresh", exactly as skip() did before there was a lookahead.
     */
    async takePick(): Promise<string | undefined> {
        const songId = this.picks.shift();
        this.generation++;

        if (songId == undefined) {
            return undefined;
        }

        return (await this.source.isEligible(songId)) ? songId : undefined;
    }

    /**
     * Recomputes the lookahead: the queue, else forward history, then reserved picks for the rest, picking more
     * when there are too few. Returns the songs in play order, or undefined when something changed the picks while
     * it ran; the answer is stale then, and the caller should refresh again.
     */
    async refresh(): Promise<string[] | undefined> {
        const generation = this.generation;
        const queue = this.source.queue();
        // Same branch as skip(): a non-empty queue is played first, and playing from it truncates forward history,
        // so history never comes after a queued song.
        const upcoming = queue.length > 0
            ? queue.slice(0, this.size)
            : await this.source.forwardHistory(this.size);
        const needed = Math.max(0, this.size - upcoming.length);

        const picks: string[] = [];
        for (const songId of this.picks.slice(0, needed)) {
            if (await this.source.isEligible(songId)) {
                picks.push(songId);
            }
        }

        while (picks.length < needed) {
            const current = this.source.current();
            const played = [...(current == undefined ? [] : [current]), ...upcoming, ...picks];
            const songId = await this.source.pick(played);

            // A pool too small to avoid repeats can hand back a song already lined up. Lining it up twice would just
            // play it twice in a row, so stop short instead.
            if (songId == undefined || upcoming.includes(songId) || picks.includes(songId)) {
                break;
            }

            picks.push(songId);
        }

        if (generation !== this.generation) {
            return undefined;
        }

        this.picks = picks;
        return [...upcoming, ...picks];
    }
}
