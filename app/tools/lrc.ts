// Minimal LRC (synced-lyrics) parser. Input is the `[mm:ss.xx]line` text the producer fetched
// (LRCLIB / YT Music); output is a flat, time-sorted list of lines. Pure + dependency-free so it is
// trivially unit-testable.

export interface LrcLine {
    timeMs: number;
    text: string;
}

// Matches a single `[mm:ss.xx]` / `[mm:ss.xxx]` / `[mm:ss]` timestamp. The fraction separator may be a
// dot or a colon depending on the source. Non-time metadata tags ([ar:], [ti:], [offset:], …) don't
// match and are ignored.
const TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(lrc: string): LrcLine[] {
    const out: LrcLine[] = [];

    for (const raw of lrc.split(/\r?\n/)) {
        TIME_TAG.lastIndex = 0;
        const stamps: number[] = [];
        let consumedTo = 0;
        let match: RegExpExecArray | null;

        // Consume only the contiguous leading timestamps (a line may carry several, e.g. a repeated
        // chorus). Stop at the first non-leading match so a stray mid-line bracket stays as text.
        while ((match = TIME_TAG.exec(raw)) !== null) {
            if (match.index !== consumedTo) {
                break;
            }

            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const fracMs = match[3] ? Math.round(Number("0." + match[3]) * 1000) : 0;
            stamps.push(minutes * 60000 + seconds * 1000 + fracMs);
            consumedTo = TIME_TAG.lastIndex;
        }

        if (stamps.length === 0) {
            continue;
        }

        const text = raw.slice(consumedTo).trim();
        for (const timeMs of stamps) {
            out.push({ timeMs, text });
        }
    }

    out.sort((a, b) => a.timeMs - b.timeMs);
    return out;
}

// Index of the active line for a given playback position: the last line whose timestamp is <= the
// position, or -1 when playback is before the first line. Binary search (lines are pre-sorted).
export function activeLineIndex(lines: LrcLine[], positionMs: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].timeMs <= positionMs) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    return ans;
}

/**
 * Whether a song has lyrics worth showing a lyrics UI for.
 *
 * Deliberately does NOT count `lyricsInstrumental`. The flag is real and useful data - it is how the producer
 * knows this track has no lyrics BY DESIGN and stops re-querying providers for it forever - but as a panel it
 * only ever renders a "♪ Instrumental ♪" placeholder, which is a lyrics UI that exists to say there are no
 * lyrics. Treating it as "no lyrics" here hides the toggle entirely while leaving the fact intact in the data.
 */
export function hasDisplayableLyrics(song: { syncedLyrics?: string | null; plainLyrics?: string | null } | null | undefined): boolean {
    return !!(song && (song.syncedLyrics || song.plainLyrics));
}
