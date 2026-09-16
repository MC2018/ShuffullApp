// Tap-tempo: derive a BPM from the timestamps of rhythmic screen taps. Pure + dependency-free so it can be
// unit-tested and imported anywhere (the curator BPM edit uses it).

export const TAP_STALE_MS = 2000; // a pause longer than this starts a fresh measurement

/**
 * Folds a new tap (at `nowMs`) into the running tap list. Every tap since the last reset is kept (no window) so
 * the estimate keeps getting more accurate the longer you tap; a pause longer than `staleMs` starts fresh on the
 * next tap. Pure — returns a new array.
 */
export function nextTaps(prev: number[], nowMs: number, staleMs = TAP_STALE_MS): number[] {
    const taps = prev.length > 0 && nowMs - prev[prev.length - 1] > staleMs ? [] : prev;
    return [...taps, nowMs];
}

/**
 * BPM from tap timestamps (ms), using the average inter-tap interval. Returns null until there are at least two
 * taps, or when the result is musically implausible.
 */
export function computeTapBpm(timestampsMs: number[]): number | null {
    if (timestampsMs.length < 2) {
        return null;
    }

    const intervals: number[] = [];
    for (let i = 1; i < timestampsMs.length; i++) {
        const delta = timestampsMs[i] - timestampsMs[i - 1];
        if (delta > 0) {
            intervals.push(delta);
        }
    }
    if (intervals.length === 0) {
        return null;
    }

    const avg = intervals.reduce((sum, d) => sum + d, 0) / intervals.length;
    const bpm = Math.round(60000 / avg);
    return bpm >= 20 && bpm <= 400 ? bpm : null;
}
