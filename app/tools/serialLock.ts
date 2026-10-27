/**
 * Runs async tasks one at a time, in the order they were requested.
 *
 * Built for the media manager's transport controls (ShuffullApp#22). play, pause, skip and previous each read
 * state, await the database and the player several times, then write. Two of them overlapping interleave at
 * every await: two fast skip taps both read the same current song and both rewrite the recently-played rows,
 * and a pause landing while a skip is loading the next track is undone by that skip's own play(). Running them
 * in sequence means each one starts from the state the previous one left.
 *
 * NOT re-entrant: a task that calls `run` on its own lock waits for itself until the hold limit. Code already
 * inside the lock calls the unlocked implementation instead.
 *
 * Extracted from mediaManager so it is testable - mediaManager imports react-native-track-player and cannot be
 * loaded in a unit test.
 */

/**
 * How long a task may hold the lock before the next one stops waiting for it. Every transport action is a few
 * local reads and writes plus native calls that return once the work is queued, so a holder this slow is stuck,
 * not busy. Without a limit, one native call that never settles would leave every control dead until the app
 * restarts, which is worse than the race the lock prevents.
 */
export const DEFAULT_MAX_HOLD_MS = 15_000;

export interface SerialLock {
    run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSerialLock(options: { maxHoldMs?: number; name?: string } = {}): SerialLock {
    const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    const name = options.name ?? "lock";
    // Settles once the most recently queued task has released the lock. Never rejects, so one failed task
    // cannot poison the chain for the ones behind it.
    let tail: Promise<void> = Promise.resolve();

    return {
        run<T>(task: () => Promise<T>): Promise<T> {
            const previous = tail;
            const result = previous.then(() => task());

            tail = (async () => {
                await previous;
                // The clock starts only now, when this task does: the limit is on how long it HOLDS the lock,
                // not on how long it queued behind others.
                let timer: ReturnType<typeof setTimeout> | undefined;
                const givenUp = new Promise<void>((resolve) => {
                    timer = setTimeout(() => {
                        console.warn(`[${name}] a task held the lock for over ${maxHoldMs}ms - letting the next one run.`);
                        resolve();
                    }, maxHoldMs);
                });

                await Promise.race([result.then(() => undefined, () => undefined), givenUp]);
                clearTimeout(timer);
            })();

            return result;
        },
    };
}
