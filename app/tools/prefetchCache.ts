/**
 * Rules for the prefetch cache: upcoming songs fetched ahead of a skip so it starts at once (ShuffullApp#124).
 *
 * The cache is NOT Downloads. Nothing in it is recorded as downloaded or counted anywhere, it lives in the OS cache
 * directory, and it only ever holds the song playing now plus the lookahead. Extracted from the native prefetcher so
 * the eviction rules are testable without expo-file-system.
 */

/** Total size the cache may hold, playing song included. A few songs at the usual 5-10 MB. */
export const PREFETCH_CACHE_CAP_BYTES = 100 * 1024 * 1024;

export interface PrefetchEntry {
    songId: string;
    bytes: number;
    /** Epoch ms the file landed. */
    fetchedAt: number;
    /** It has started playing at least once. */
    played: boolean;
}

export interface EvictionContext {
    /** The lookahead, in play order. */
    wanted: readonly string[];
    /** The song playing now. Its file may be open in the player, so it is never evicted. */
    playing: string | undefined;
    capBytes: number;
}

/**
 * Which entries to delete, by song id.
 *
 *   1. The playing song stays, whatever else holds.
 *   2. A song that has played, or has dropped out of the lookahead, goes. It was fetched to start one skip quickly,
 *      and that skip has happened or will not.
 *   3. If the rest is still over the cap, lined-up songs go from the BACK of the lookahead: the one furthest away.
 *      Evicting the oldest here would evict the next song to make room for the one after it, which the prefetcher
 *      would then fetch again, evicting the other, forever.
 */
export function choosePrefetchEvictions(entries: readonly PrefetchEntry[], context: EvictionContext): string[] {
    const oldestFirst = [...entries].sort((a, b) => a.fetchedAt - b.fetchedAt);
    const evicted: string[] = [];
    const kept: PrefetchEntry[] = [];

    for (const entry of oldestFirst) {
        const isPlaying = entry.songId === context.playing;

        if (!isPlaying && (entry.played || !context.wanted.includes(entry.songId))) {
            evicted.push(entry.songId);
        } else {
            kept.push(entry);
        }
    }

    let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    const furthestFirst = kept
        .filter(entry => entry.songId !== context.playing)
        .sort((a, b) => context.wanted.indexOf(b.songId) - context.wanted.indexOf(a.songId));

    for (const entry of furthestFirst) {
        if (total <= context.capBytes) {
            break;
        }

        evicted.push(entry.songId);
        total -= entry.bytes;
    }

    return evicted;
}

/** The "Load upcoming songs ahead" setting as stored. On unless turned off, including on mobile data (2026-10-27). */
export function parsePrefetchSetting(stored: string | null | undefined): boolean {
    return stored !== "0";
}
