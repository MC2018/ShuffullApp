import { Song } from "../db/models";

/** Local copies of a prefetched song, ready to hand to the player. */
export interface PrefetchedFiles {
    audioUri: string;
    /** Undefined when the server had no art for it. */
    artUri: string | undefined;
}

/**
 * Fetches the lookahead into a cache that is not Downloads (ShuffullApp#124). Native in `Prefetcher.ts`; the web
 * build (`Prefetcher.web.ts`) is a stub that reports `supported: false`, so desktop keeps picking at skip time.
 */
export interface Prefetcher {
    readonly supported: boolean;
    /** The songs to have on hand, in play order. Replaces the previous list; anything not on it is thrown away. */
    want(songs: readonly Song[]): void;
    /** The song the player is starting. Its file is kept while it plays and dropped once it has. */
    markPlaying(songId: string | undefined): void;
    /** The cached files for this exact song (same file hash), if they are fully on disk. */
    filesFor(song: Song): Promise<PrefetchedFiles | undefined>;
}
