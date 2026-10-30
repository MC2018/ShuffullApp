import { Song } from "../db/models";
import { choosePrefetchEvictions, PREFETCH_CACHE_CAP_BYTES, PrefetchEntry } from "../../tools/prefetchCache";
import { PrefetchedFiles, Prefetcher } from "./types";

/** One song's files as the store holds them, with the URIs the player loads them from. */
export interface StoredSong {
    bytes: number;
    audioUri: string;
    /** Undefined when the server had no art for it. */
    artUri: string | undefined;
}

/**
 * Where the prefetched files live. The desktop's is the Electron shell's prefetch folder (Prefetcher.web.ts); the
 * tests use an in-memory fake. Everything platform-specific is behind this, so the bookkeeping below is plain code.
 */
export interface PrefetchStore {
    /** Empties the store. Runs once, before anything is fetched. */
    clear(): Promise<void>;
    /** False when there is no host or no connection: nothing is fetched, and the song streams as it always did. */
    canFetch(): Promise<boolean>;
    /** Already in Downloads: it plays from there, so a second copy would be waste. */
    isDownloaded(song: Song): Promise<boolean>;
    /**
     * Fetches the song's audio, hash-checked against its file hash, then its art. On any failure, a bad hash or a
     * cancel it says why, and leaves nothing behind. Art is best-effort and never fails the song.
     */
    fetch(song: Song): Promise<StoredSong | { error: string }>;
    /** Aborts the song's fetch if it is in flight. */
    cancel(song: Song): void;
    /** The audio is still there. The store may lose files the index still lists. */
    exists(song: Song): Promise<boolean>;
    /** Deletes the song's audio and art. Idempotent. */
    remove(song: Song): Promise<void>;
}

interface CachedSong extends PrefetchEntry, StoredSong {
    song: Song;
}

interface FetchJob {
    song: Song;
    cancelled: boolean;
}

/**
 * The prefetch cache's bookkeeping over a `PrefetchStore`: which songs to fetch, in what order, which to drop, and
 * which file is safe to play (ShuffullApp#124, desktop ShuffullApp#137). It follows the native `Prefetcher.ts`
 * rule for rule:
 *
 * - One song at a time, in play order, skipping the playing song and anything already downloaded.
 * - Evicts with `choosePrefetchEvictions` under the ~100 MB cap. A lined-up song the cap pushes out isn't fetched
 *   again until the lookahead changes, or it would be fetched and evicted over and over.
 * - A fetch for a song taken off the list, or one that starts playing first, is cancelled.
 * - The index is in memory only and the store is emptied at start-up, so no file is trusted without the index
 *   that vouches for it. `filesFor` answers only for the exact file hash, and only while the file still exists.
 * - No retry loop. A failed fetch leaves the song to stream, and the next lookahead change tries again.
 *
 * Nothing here is a download: it never touches the downloaded-songs table or the download queue.
 */
export class StorePrefetcher implements Prefetcher {
    readonly supported = true;

    private readonly ready: Promise<void>;
    private cached = new Map<string, CachedSong>();
    private wanted: Song[] = [];
    private playing: string | undefined;
    private inFlight: FetchJob | undefined;
    private overCap = new Set<string>();
    private running = false;
    private rerun = false;
    private idle: Promise<void> = Promise.resolve();

    constructor(private readonly store: PrefetchStore, private readonly capBytes = PREFETCH_CACHE_CAP_BYTES) {
        this.ready = store.clear().catch(e => console.warn("[prefetch] could not empty the cache", e));
    }

    want(songs: readonly Song[]): void {
        const before = this.wanted.map(song => song.songId).join(",");
        this.wanted = [...songs];

        if (this.wanted.map(song => song.songId).join(",") !== before) {
            this.overCap.clear();
        }

        if (this.inFlight != undefined && !this.isWanted(this.inFlight.song.songId)) {
            this.cancel(this.inFlight, "no longer lined up");
        }

        this.kick();
    }

    markPlaying(songId: string | undefined): void {
        this.playing = songId;
        const entry = songId == undefined ? undefined : this.cached.get(songId);

        if (entry != undefined) {
            entry.played = true;
        }

        // Starting a song this cache is still fetching means the player streams it anyway; finishing the fetch
        // would only download it twice.
        if (this.inFlight != undefined && this.inFlight.song.songId === songId) {
            this.cancel(this.inFlight, "it started before the fetch finished");
        }

        this.kick();
    }

    async filesFor(song: Song): Promise<PrefetchedFiles | undefined> {
        const entry = this.cached.get(song.songId);

        if (entry == undefined || entry.song.fileHash !== song.fileHash) {
            return undefined;
        }

        if (!(await this.store.exists(entry.song).catch(() => false))) {
            this.cached.delete(song.songId);
            return undefined;
        }

        return { audioUri: entry.audioUri, artUri: entry.artUri };
    }

    /** Resolves once the fetch loop has nothing left to do. For tests; the app never waits on the cache. */
    settled(): Promise<void> {
        return this.idle;
    }

    private isWanted(songId: string): boolean {
        return this.wanted.some(song => song.songId === songId);
    }

    private cancel(job: FetchJob, reason: string) {
        if (job.cancelled) {
            return;
        }

        job.cancelled = true;
        console.info(`[prefetch] cancelled ${job.song.songId}: ${reason}`);
        this.store.cancel(job.song);
    }

    /** Runs the fetch loop if it isn't running; if it is, makes it go round once more with the latest list. */
    private kick() {
        if (this.running) {
            this.rerun = true;
            return;
        }

        this.running = true;
        this.idle = (async () => {
            try {
                await this.ready;
                do {
                    this.rerun = false;
                    await this.fill();
                } while (this.rerun);
            } catch (e) {
                console.warn("[prefetch] fetch loop failed", e);
            } finally {
                this.running = false;
            }
        })();
    }

    private async fill() {
        await this.evict();

        for (const song of [...this.wanted]) {
            // The list can change under an await; a song taken off it is no longer this loop's business.
            if (!this.isWanted(song.songId) || this.overCap.has(song.songId) || song.songId === this.playing) {
                continue;
            }

            const previous = this.cached.get(song.songId);

            if (previous?.song.fileHash === song.fileHash) {
                continue;
            }

            // The song's file was replaced since it was fetched. Files are named by hash, so the old ones would
            // otherwise sit in the store, uncounted, until the next start-up.
            if (previous != undefined) {
                this.cached.delete(song.songId);
                await this.store.remove(previous.song).catch(() => undefined);
            }

            if (await this.store.isDownloaded(song)) {
                continue;
            }

            await this.fetch(song);
            await this.evict();

            if (this.overCap.has(song.songId)) {
                // The cap is full of songs that come sooner. Nothing after this one will fit either.
                return;
            }
        }
    }

    private async fetch(song: Song) {
        if (!(await this.store.canFetch())) {
            return;
        }

        // want() and markPlaying() can't cancel a job until inFlight is set, so check again after the await.
        if (!this.isWanted(song.songId) || song.songId === this.playing) {
            return;
        }

        const job: FetchJob = { song, cancelled: false };
        const startedAt = Date.now();
        this.inFlight = job;

        try {
            console.info(`[prefetch] fetching ${song.songId} (${song.name})`);
            const stored = await this.store.fetch(song);

            if (job.cancelled) {
                // A fetch can finish in the moment between the cancel and the abort reaching it.
                if (!("error" in stored)) {
                    await this.store.remove(song).catch(() => undefined);
                }
                return;
            }

            if ("error" in stored) {
                console.warn(`[prefetch] fetching ${song.songId} failed (${stored.error}); it will stream`);
                return;
            }

            this.cached.set(song.songId, { ...stored, song, songId: song.songId, fetchedAt: Date.now(), played: false });
            console.info(`[prefetch] ready ${song.songId}: ${(stored.bytes / 1024 / 1024).toFixed(1)} MB in ${Date.now() - startedAt} ms`);
        } catch (e) {
            if (!job.cancelled) {
                console.warn(`[prefetch] fetching ${song.songId} failed; it will stream`, e);
            }
        } finally {
            if (this.inFlight === job) {
                this.inFlight = undefined;
            }
        }
    }

    private async evict() {
        const wanted = this.wanted.map(song => song.songId);
        const evicted = choosePrefetchEvictions([...this.cached.values()], {
            wanted,
            playing: this.playing,
            capBytes: this.capBytes,
        });

        for (const songId of evicted) {
            const entry = this.cached.get(songId);
            this.cached.delete(songId);

            if (entry == undefined) {
                continue;
            }

            if (wanted.includes(songId) && !entry.played) {
                this.overCap.add(songId);
            }

            await this.store.remove(entry.song).catch(() => undefined);
        }
    }
}
