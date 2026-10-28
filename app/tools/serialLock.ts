/**
 * Runs async tasks one at a time, in the order they were requested, each starting from the state the previous
 * one left. A task that fails rejects only its own caller; the ones behind it still run.
 *
 * NOT re-entrant: a task that calls `run` on its own lock waits for itself until the hold limit. Code already
 * inside the lock calls the unlocked implementation instead.
 *
 * Extracted from mediaManager so it is testable - mediaManager imports react-native-track-player and cannot be
 * loaded in a unit test.
 */

/**
 * How long a task may hold the lock before the next one stops waiting for it. A task this slow is stuck, not
 * busy. Without a limit, one call that never settles would block every task behind it for good.
 */
const DEFAULT_MAX_HOLD_MS = 15_000;

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
