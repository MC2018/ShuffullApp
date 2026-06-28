// Tap-tempo: derive a BPM from the timestamps of rhythmic screen taps. Pure + dependency-free so it can be
// unit-tested and imported anywhere (the curator BPM edit uses it).

export const TAP_STALE_MS = 2000; // a pause longer than this starts a fresh measurement
export const TAP_WINDOW = 8;      // average over at most the last N taps (adapts as you keep tapping)

/**
 * Folds a new tap (at `nowMs`) into the running tap list: restarts the measurement after a long pause, and
 * keeps only the most recent `maxTaps`. Pure — returns a new array.
 */
export function nextTaps(prev: number[], nowMs: number, staleMs = TAP_STALE_MS, maxTaps = TAP_WINDOW): number[] {
    let taps = prev;
    if (taps.length > 0 && nowMs - taps[taps.length - 1] > staleMs) {
        taps = [];
    }
    taps = [...taps, nowMs];
    if (taps.length > maxTaps) {
        taps = taps.slice(taps.length - maxTaps);
    }
    return taps;
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
