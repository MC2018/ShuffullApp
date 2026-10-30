import { Prefetcher } from "./types";

/**
 * Web build: no prefetch yet. The native cache is built on expo-file-system, which has no web implementation, and
 * the desktop's offline store is the Downloads store, which the prefetch cache must stay apart from. `supported` is
 * false, so the player keeps picking at skip time and streams exactly as before (desktop follow-up: ShuffullApp#137).
 */
export const prefetcher: Prefetcher = {
    supported: false,
    want: () => undefined,
    markPlaying: () => undefined,
    filesFor: async () => undefined,
};
