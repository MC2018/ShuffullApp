import type { SongFilters } from "../types/SongFilters";
import type { ShuffleCandidate } from "./shuffle";

/**
 * Which songs the shuffle may pick, with or without the server (ShuffullApp#24). Extracted from mediaManager so the
 * rules are testable: mediaManager imports react-native-track-player and cannot be loaded in a unit test.
 */
export interface ShuffleSource {
    filters: SongFilters;
    serverUnreachable: boolean;
    /** getFilteredSong: the songs matching these filters, ordered by last_played ASC. */
    query(filters: SongFilters): Promise<ShuffleCandidate[]>;
    songExists(songId: string): Promise<boolean>;
    /** Whether the song is already in the prefetch cache, so it plays without the server. */
    isPrefetched(songId: string): Promise<boolean>;
}

/**
 * While the server can't be reached a streamed song can't load, and each pick of one stalls playback on "Waiting for
 * connection". So the shuffle narrows to the scope's downloaded songs. Undefined when the server is reachable, and
 * when the scope has nothing downloaded: playing on then waits for the connection, as it always did.
 */
export async function offlineShufflePool(source: ShuffleSource): Promise<ShuffleCandidate[] | undefined> {
    if (!source.serverUnreachable || source.filters.localOnly) {
        return undefined;
    }

    const pool = await source.query(source.filters.withLocalOnly());
    return pool.length ? pool : undefined;
}

/**
 * The songs the shuffle picks from: the downloaded ones in scope while the server can't be reached, else the scope's
 * songs when any filter is set, or undefined for "the whole library". No scope set used to return nothing, which
 * halted playback after a single song whenever the filters happened to be empty, the dead end reached from any list
 * screen.
 */
export async function shufflePool(source: ShuffleSource): Promise<ShuffleCandidate[] | undefined> {
    return await offlineShufflePool(source) ?? await scopePool(source);
}

/** Whether a song picked ahead may still be the shuffle's next song: still in the pool, or the library. */
export async function isShuffleEligible(songId: string, source: ShuffleSource): Promise<boolean> {
    const offlinePool = await offlineShufflePool(source);

    if (offlinePool != undefined) {
        if (offlinePool.some(x => x.songId === songId)) {
            return true;
        }
        // A song lined up before the connection went, and already fetched, plays from the prefetch cache: keep it.
        if (!await source.isPrefetched(songId)) {
            return false;
        }
    }

    const pool = await scopePool(source);

    if (pool != undefined) {
        return pool.some(x => x.songId === songId);
    }

    return await source.songExists(songId);
}

async function scopePool(source: ShuffleSource): Promise<ShuffleCandidate[] | undefined> {
    return source.filters.hasAnyFilter() ? await source.query(source.filters) : undefined;
}
