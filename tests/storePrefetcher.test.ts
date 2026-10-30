import { beforeEach, describe, expect, it, vi } from "vitest";
import { Song } from "@/app/services/db/models";
import { PrefetchStore, StoredSong, StorePrefetcher } from "@/app/services/prefetch/StorePrefetcher";

/**
 * The desktop prefetch cache's bookkeeping (ShuffullApp#137), over a fake store. What must hold, as on native
 * (ShuffullApp#124): fetch the lookahead in order and nothing else, never trust a file the index doesn't vouch
 * for or a file that is gone, drop what has played, stay under the cap without fetching the same song forever, and
 * stop a fetch the lookahead no longer wants.
 */

const MB = 1024 * 1024;

function song(id: string, fileHash = `hash-${id}`): Song {
    return {
        songId: id, fileExtension: ".mp3", fileHash, name: `Song ${id}`,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, heaviness: null, exploratory: false, tagsStale: false, hookStartPercent: null,
    };
}

type FetchResult = StoredSong | { error: string };

/** An in-memory store. Fetches resolve at once unless `hold` is set, when each waits for `release`. */
class FakeStore implements PrefetchStore {
    files = new Set<string>();
    downloaded = new Set<string>();
    fetched: string[] = [];
    cancelled: string[] = [];
    removed: string[] = [];
    clears = 0;
    online = true;
    hold = false;
    bytes = 10 * MB;
    failing = new Set<string>();
    // Resolves a held fetch: with the given result, or as if it had completed.
    private pending = new Map<string, (result?: FetchResult) => void>();

    async clear() {
        this.clears++;
        this.files.clear();
    }

    async canFetch() {
        return this.online;
    }

    async isDownloaded(s: Song) {
        return this.downloaded.has(s.songId);
    }

    fetch(s: Song): Promise<FetchResult> {
        this.fetched.push(s.songId);
        const finish = (): FetchResult => {
            if (this.failing.has(s.songId)) {
                return { error: "integrity check failed" };
            }
            this.files.add(s.fileHash);
            return { bytes: this.bytes, audioUri: `prefetch://${s.fileHash}.mp3`, artUri: `prefetch://${s.fileHash}.jpg` };
        };
        if (!this.hold) {
            return Promise.resolve(finish());
        }
        return new Promise(resolve => this.pending.set(s.songId, result => resolve(result ?? finish())));
    }

    /** Lets a held fetch finish, as if the cancel hadn't reached it in time. */
    release(songId: string) {
        this.pending.get(songId)?.();
        this.pending.delete(songId);
    }

    cancel(s: Song) {
        this.cancelled.push(s.songId);
        const resolve = this.pending.get(s.songId);
        this.pending.delete(s.songId);
        resolve?.({ error: "aborted" });
    }

    async exists(s: Song) {
        return this.files.has(s.fileHash);
    }

    async remove(s: Song) {
        this.removed.push(s.songId);
        this.files.delete(s.fileHash);
    }
}

/** Lets the fetch loop run until it has nothing left to do. */
async function settle(prefetcher: StorePrefetcher) {
    for (let i = 0; i < 5; i++) {
        await prefetcher.settled();
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

let store: FakeStore;

beforeEach(() => {
    store = new FakeStore();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("StorePrefetcher", () => {
    it("empties the store before fetching the lookahead, in play order", async () => {
        store.files.add("left-over");
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a"), song("b")]);
        await settle(prefetcher);

        expect(store.clears).toBe(1);
        expect(store.files.has("left-over")).toBe(false);
        expect(store.fetched).toEqual(["a", "b"]);
        expect(await prefetcher.filesFor(song("a"))).toEqual({ audioUri: "prefetch://hash-a.mp3", artUri: "prefetch://hash-a.jpg" });
    });

    it("skips the playing song and anything already downloaded", async () => {
        store.downloaded.add("b");
        const prefetcher = new StorePrefetcher(store);
        prefetcher.markPlaying("a");
        prefetcher.want([song("a"), song("b"), song("c")]);
        await settle(prefetcher);

        expect(store.fetched).toEqual(["c"]);
    });

    it("fetches nothing while offline", async () => {
        store.online = false;
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a")]);
        await settle(prefetcher);

        expect(store.fetched).toEqual([]);
        expect(await prefetcher.filesFor(song("a"))).toBeUndefined();
    });

    it("hands back a file only for the same file hash, and only while it still exists", async () => {
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a"), song("b")]);
        await settle(prefetcher);

        expect(await prefetcher.filesFor(song("a", "other-hash"))).toBeUndefined();

        store.files.delete("hash-b");
        expect(await prefetcher.filesFor(song("b"))).toBeUndefined();
        store.files.add("hash-b");
        // Forgotten once found missing: the index never vouches for it again.
        expect(await prefetcher.filesFor(song("b"))).toBeUndefined();
    });

    it("records nothing when the hash check fails", async () => {
        store.failing.add("a");
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a"), song("b")]);
        await settle(prefetcher);

        expect(store.fetched).toEqual(["a", "b"]);
        expect(await prefetcher.filesFor(song("a"))).toBeUndefined();
        expect(await prefetcher.filesFor(song("b"))).toBeDefined();
    });

    it("drops a song once the next one starts, but never the one playing", async () => {
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a"), song("b")]);
        await settle(prefetcher);

        prefetcher.markPlaying("a");
        prefetcher.want([song("b"), song("c")]);
        await settle(prefetcher);
        expect(store.removed).toEqual([]);
        expect(await prefetcher.filesFor(song("a"))).toBeDefined();

        prefetcher.markPlaying("b");
        prefetcher.want([song("c"), song("d")]);
        await settle(prefetcher);
        expect(store.removed).toEqual(["a"]);
        expect(await prefetcher.filesFor(song("b"))).toBeDefined();
    });

    it("stays under the cap and doesn't refetch what the cap pushed out until the lookahead changes", async () => {
        const prefetcher = new StorePrefetcher(store, 25 * MB);
        prefetcher.want([song("a"), song("b"), song("c")]);
        await settle(prefetcher);

        expect(store.fetched).toEqual(["a", "b", "c"]);
        expect(store.removed).toEqual(["c"]);

        prefetcher.markPlaying(undefined);
        prefetcher.want([song("a"), song("b"), song("c")]);
        await settle(prefetcher);
        expect(store.fetched).toEqual(["a", "b", "c"]);

        prefetcher.want([song("b"), song("c")]);
        await settle(prefetcher);
        expect(store.fetched).toEqual(["a", "b", "c", "c"]);
        expect(await prefetcher.filesFor(song("c"))).toBeDefined();
    });

    it("cancels a fetch the lookahead dropped, and keeps nothing from it", async () => {
        store.hold = true;
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a")]);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(store.fetched).toEqual(["a"]);

        prefetcher.want([]);
        await settle(prefetcher);

        expect(store.cancelled).toEqual(["a"]);
        expect(await prefetcher.filesFor(song("a"))).toBeUndefined();
    });

    it("cancels a fetch for the song that just started playing", async () => {
        store.hold = true;
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a"), song("b")]);
        await new Promise(resolve => setTimeout(resolve, 0));

        prefetcher.markPlaying("a");
        store.hold = false;
        await settle(prefetcher);

        expect(store.cancelled).toEqual(["a"]);
        expect(store.fetched).toEqual(["a", "b"]);
        expect(await prefetcher.filesFor(song("a"))).toBeUndefined();
    });

    it("deletes a fetch that finished just after it was cancelled", async () => {
        store.hold = true;
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a")]);
        await new Promise(resolve => setTimeout(resolve, 0));

        // The cancel arrives, but the store's fetch completes anyway.
        store.cancel = (s: Song) => void store.cancelled.push(s.songId);
        prefetcher.want([]);
        store.release("a");
        await settle(prefetcher);

        expect(store.removed).toEqual(["a"]);
        expect(store.files.size).toBe(0);
    });

    it("throws out the old file when a song's file changes, then fetches the new one", async () => {
        const prefetcher = new StorePrefetcher(store);
        prefetcher.want([song("a", "old")]);
        await settle(prefetcher);

        prefetcher.want([song("a", "new")]);
        await settle(prefetcher);

        expect(store.removed).toEqual(["a"]);
        expect(store.files).toEqual(new Set(["new"]));
        expect(await prefetcher.filesFor(song("a", "new"))).toBeDefined();
    });
});
