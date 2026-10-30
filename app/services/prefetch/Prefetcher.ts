import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getNetworkStateAsync } from "expo-network";
import path from "path-browserify";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { Song } from "../db/models";
import { Downloader } from "../downloader/Downloader";
import { verifyFileIntegrity } from "../../tools/utils";
import { choosePrefetchEvictions, PREFETCH_CACHE_CAP_BYTES, PrefetchEntry } from "../../tools/prefetchCache";
import { PrefetchedFiles, Prefetcher } from "./types";

interface CachedSong extends PrefetchEntry {
    fileHash: string;
    audioUri: string;
    artUri: string | undefined;
}

interface FetchJob {
    songId: string;
    cancelled: boolean;
    task: FileSystem.DownloadResumable | undefined;
}

/**
 * Native prefetch cache (ShuffullApp#124). Fetches the lookahead one song at a time, in play order, so a skip finds
 * the next song already on disk and starts it with no stream.
 *
 * Kept apart from Downloads on purpose. The files live under the OS cache directory, not the music folder, so
 * `Downloader.fileExists` never sees them, nothing is written to the downloaded-songs table, and no list or count
 * includes them. The index is in memory only and the folder is emptied at launch: a cache that only holds the next
 * song or two has nothing worth carrying across a restart, and starting empty means no file is ever trusted without
 * the index that vouches for it.
 *
 * No retry loop. A fetch that fails leaves the song to stream as it always did, and the next lookahead change tries
 * again.
 */
class NativePrefetcher implements Prefetcher {
    readonly supported = true;

    private readonly folder: string;
    private readonly tempFolder: string;
    private readonly ready: Promise<void>;
    private cached = new Map<string, CachedSong>();
    private wanted: Song[] = [];
    private playing: string | undefined;
    private inFlight: FetchJob | undefined;
    // Lined-up songs the cap pushed out. Not fetched again until the lookahead changes, or they would be refetched
    // and evicted over and over.
    private overCap = new Set<string>();
    private running = false;
    private rerun = false;

    constructor(cacheDirectory: string) {
        const folder = path.join(cacheDirectory, "prefetch");
        const tempFolder = path.join(folder, "temp");
        this.folder = folder;
        this.tempFolder = tempFolder;
        this.ready = (async () => {
            try {
                await FileSystem.deleteAsync(folder, { idempotent: true });
                await FileSystem.makeDirectoryAsync(tempFolder, { intermediates: true });
            } catch (e) {
                console.warn("[prefetch] could not prepare the cache folder", e);
            }
        })();
    }

    want(songs: readonly Song[]): void {
        const before = this.wanted.map(song => song.songId).join(",");
        this.wanted = [...songs];

        if (this.wanted.map(song => song.songId).join(",") !== before) {
            this.overCap.clear();
        }

        if (this.inFlight != undefined && !this.isWanted(this.inFlight.songId)) {
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
        if (this.inFlight != undefined && this.inFlight.songId === songId) {
            this.cancel(this.inFlight, "it started before the fetch finished");
        }

        this.kick();
    }

    async filesFor(song: Song): Promise<PrefetchedFiles | undefined> {
        const entry = this.cached.get(song.songId);

        if (entry == undefined || entry.fileHash !== song.fileHash) {
            return undefined;
        }

        // The OS may clear its cache directory under storage pressure, so the index alone isn't proof.
        if (!(await Downloader.fileExists(entry.audioUri))) {
            this.cached.delete(song.songId);
            return undefined;
        }

        return { audioUri: entry.audioUri, artUri: entry.artUri };
    }

    private isWanted(songId: string): boolean {
        return this.wanted.some(song => song.songId === songId);
    }

    private cancel(job: FetchJob, reason: string) {
        if (job.cancelled) {
            return;
        }

        job.cancelled = true;
        console.info(`[prefetch] cancelled ${job.songId}: ${reason}`);
        void job.task?.cancelAsync().catch(() => undefined);
    }

    /** Runs the fetch loop if it isn't running; if it is, makes it go round once more with the latest list. */
    private kick() {
        if (this.running) {
            this.rerun = true;
            return;
        }

        this.running = true;
        void (async () => {
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

            if (this.cached.get(song.songId)?.fileHash === song.fileHash) {
                continue;
            }

            // Already downloaded: it plays from Downloads, so a second copy would be waste.
            if (await Downloader.fileExists(Downloader.generateLocalSongUri(song))) {
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
        const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
        const network = await getNetworkStateAsync();

        // Any connection will do, mobile data included (decided 2026-10-27); the setting is the off switch.
        if (hostAddress == null || network.isInternetReachable === false) {
            return;
        }

        const fileName = Downloader.generateSongFileName(song);
        const artFileName = Downloader.generateAlbumArtFileName(song);
        const tempAudio = path.join(this.tempFolder, fileName);
        const tempArt = path.join(this.tempFolder, artFileName);
        const audioUri = path.join(this.folder, fileName);
        const artUri = path.join(this.folder, artFileName);
        const job: FetchJob = { songId: song.songId, cancelled: false, task: undefined };
        const startedAt = Date.now();
        this.inFlight = job;

        try {
            console.info(`[prefetch] fetching ${song.songId} (${song.name})`);
            job.task = FileSystem.createDownloadResumable(path.join(hostAddress, "music", fileName), tempAudio);
            const audio = await job.task.downloadAsync();

            if (job.cancelled) {
                return;
            }

            // downloadAsync resolves on any HTTP status, writing the error body as if it were the file.
            if (audio == undefined || audio.status >= 400) {
                console.warn(`[prefetch] ${song.songId} returned ${audio?.status ?? "nothing"}; it will stream`);
                return;
            }

            if (!(await verifyFileIntegrity(tempAudio))) {
                console.warn(`[prefetch] ${song.songId} failed its hash check; it will stream`);
                return;
            }

            job.task = FileSystem.createDownloadResumable(path.join(hostAddress, "albumart", artFileName), tempArt);
            const art = await job.task.downloadAsync().catch(() => undefined);

            if (job.cancelled) {
                return;
            }

            const hasArt = art != undefined && art.status < 400;
            await FileSystem.moveAsync({ from: tempAudio, to: audioUri });
            if (hasArt) {
                await FileSystem.moveAsync({ from: tempArt, to: artUri });
            }

            const info = await FileSystem.getInfoAsync(audioUri);
            const bytes = info.exists ? info.size : 0;
            this.cached.set(song.songId, {
                songId: song.songId,
                fileHash: song.fileHash,
                bytes,
                fetchedAt: Date.now(),
                played: false,
                audioUri,
                artUri: hasArt ? artUri : undefined,
            });
            console.info(`[prefetch] ready ${song.songId}: ${(bytes / 1024 / 1024).toFixed(1)} MB in ${Date.now() - startedAt} ms`);
        } catch (e) {
            if (!job.cancelled) {
                console.warn(`[prefetch] fetching ${song.songId} failed; it will stream`, e);
            }
        } finally {
            if (this.inFlight === job) {
                this.inFlight = undefined;
            }
            await FileSystem.deleteAsync(tempAudio, { idempotent: true }).catch(() => undefined);
            await FileSystem.deleteAsync(tempArt, { idempotent: true }).catch(() => undefined);
        }
    }

    private async evict() {
        const wanted = this.wanted.map(song => song.songId);
        const evicted = choosePrefetchEvictions([...this.cached.values()], {
            wanted,
            playing: this.playing,
            capBytes: PREFETCH_CACHE_CAP_BYTES,
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

            await FileSystem.deleteAsync(entry.audioUri, { idempotent: true }).catch(() => undefined);
            if (entry.artUri != undefined) {
                await FileSystem.deleteAsync(entry.artUri, { idempotent: true }).catch(() => undefined);
            }
        }
    }
}

export const prefetcher: Prefetcher = new NativePrefetcher(FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? "");
