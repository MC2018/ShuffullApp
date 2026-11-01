import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { addToDownloadQueue, countDownloadQueue, getDownloadQueueDetails } from "@/app/services/db/queries/downloadQueue";
import { updateSongs } from "@/app/services/db/queries/song";
import { downloadedSongTable, playlistSongTable } from "@/app/services/db/schema";
import { DownloadPriority } from "@/app/services/db/types";
import type { Song } from "@/app/services/db/models";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { useDownloadStatus } from "@/app/services/downloader/downloadStatus";
import { BackgroundHold, DownloadAdapter, DownloadQueueRunner, DownloadResult, KeyValueStorage } from "@/app/services/downloader/DownloadQueueRunner";
import { createDesktopDownloadAdapter, desktopDownloadResult } from "@/app/services/downloader/desktopDownloadAdapter";
import type { DesktopMediaStore } from "@/app/services/desktopShell";
import type { MediaKind } from "@/app/tools/desktopMedia";
import { MAX_CONSECUTIVE_DROPS, MAX_HASH_MISMATCHES } from "@/app/tools/downloadFailure";
import { RETRY_BASE_MS } from "@/app/tools/downloadStatus";

// The shared download loop (ShuffullApp#105) against a fake adapter and the real drizzle queries on an in-memory
// better-sqlite3 DB (same harness as downloadQueueQueries.test.ts).
function makeDb(): GenericDb {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
        CREATE TABLE songs (
            song_id TEXT PRIMARY KEY,
            file_extension TEXT NOT NULL,
            file_hash TEXT NOT NULL,
            name TEXT NOT NULL,
            synced_lyrics TEXT,
            plain_lyrics TEXT,
            lyrics_instrumental INTEGER NOT NULL DEFAULT 0,
            lyrics_source TEXT,
            bpm INTEGER,
            heaviness INTEGER,
            exploratory INTEGER NOT NULL DEFAULT 0,
            tags_stale INTEGER NOT NULL DEFAULT 0, hook_start_percent REAL
        );
        CREATE TABLE artists (artist_id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE song_artists (song_artist_id TEXT PRIMARY KEY, song_id TEXT NOT NULL, artist_id TEXT NOT NULL);
        CREATE TABLE download_queue (
            download_queue_id TEXT PRIMARY KEY,
            song_id TEXT NOT NULL UNIQUE,
            priority INTEGER NOT NULL
        );
        CREATE TABLE downloaded_songs (downloaded_song_id TEXT PRIMARY KEY, song_id TEXT NOT NULL);
        CREATE TABLE playlist_songs (playlist_song_id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, song_id TEXT NOT NULL);
    `);
    return drizzle(sqlite) as unknown as GenericDb;
}

function song(id: string): Song {
    return {
        songId: id,
        fileExtension: ".mp3",
        fileHash: `hash${id}`,
        name: `Song ${id}`,
        syncedLyrics: null,
        plainLyrics: null,
        lyricsInstrumental: false,
        lyricsSource: null,
        bpm: null,
        heaviness: null,
        exploratory: false,
        tagsStale: false,
    } as Song;
}

const music = (id: string) => `music/hash${id}.mp3`;
const art = (id: string) => `albumart/hash${id}.jpg`;

/**
 * A store in memory. `responses` scripts what each fetch answers, one entry per attempt (the last one repeats);
 * anything unscripted is a 200 that stores the file. `fetched` records every fetch in order.
 */
class FakeAdapter implements DownloadAdapter {
    readonly stored = new Set<string>();
    readonly fetched: string[] = [];
    readonly responses = new Map<string, DownloadResult[]>();
    online = true;
    wifiOnly = true;
    background: (BackgroundHold & { held: boolean }) | undefined;
    watch: ((onChange: () => void) => void) | undefined;

    async exists(kind: MediaKind, fileName: string) {
        return this.stored.has(`${kind}/${fileName}`);
    }

    async download(_host: string, kind: MediaKind, fileName: string, verify: boolean, onProgress: (fraction: number) => void): Promise<DownloadResult> {
        const key = `${kind}/${fileName}`;
        this.fetched.push(key);
        tick();
        const scripted = this.responses.get(key);
        const result = scripted == undefined ? { status: 200, hashMatches: verify ? true : undefined } : scripted.length > 1 ? scripted.shift() : scripted[0];
        onProgress(0.5);
        if (result != undefined && result.status >= 200 && result.status < 300 && (!verify || result.hashMatches)) {
            this.stored.add(key);
        }
        return result;
    }

    async canDownloadNow() {
        return this.online;
    }

    async network() {
        return { isInternetReachable: this.online, type: "WIFI" };
    }

    listSongFiles = async () => [...this.stored].filter(x => x.startsWith("music/")).map(x => x.slice("music/".length));
}

function fakeHold(): BackgroundHold & { held: boolean } {
    const hold = {
        held: false,
        hold: () => { hold.held = true; },
        release: () => { hold.held = false; },
        isHeld: () => hold.held,
        prepareForUserWork: async () => {},
    };
    return hold;
}

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { values: Map<string, string> } {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => { values.set(key, value); },
    };
}

// Queue ids are ULIDs ordered by the millisecond they were made in, so the clock is pinned and stepped: rows made in
// one millisecond have no defined order, and a deferred row must land behind the rest.
let now = 1_000;
function tick() {
    now += 1;
    vi.setSystemTime(now);
}

async function queue(db: GenericDb, ids: string[]) {
    for (const id of ids) {
        tick();
        await addToDownloadQueue(db, [id], DownloadPriority.Medium);
    }
}

async function downloadedIds(db: GenericDb): Promise<string[]> {
    return (await db.select({ songId: downloadedSongTable.songId }).from(downloadedSongTable)).map(x => x.songId).sort();
}

describe("DownloadQueueRunner", () => {
    let db: GenericDb;
    let adapter: FakeAdapter;
    let storage: ReturnType<typeof memoryStorage>;
    let sleeps: number[];
    let runner: DownloadQueueRunner;

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        useDownloadStatus.setState({ status: { phase: "idle", queuedCount: 0, completedCount: 0, skippedCount: 0 } });
        db = makeDb();
        await updateSongs(db, ["a", "b", "c", "d", "e", "f", "g", "h"].map(song));
        adapter = new FakeAdapter();
        storage = memoryStorage({ [STORAGE_KEYS.HOST_ADDRESS]: "https://api.test" });
        sleeps = [];
        runner = makeRunner();
    });

    afterEach(() => {
        runner.dispose();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function makeRunner(options: { adapter?: DownloadAdapter | undefined; maxSleeps?: number } = {}) {
        const maxSleeps = options.maxSleeps ?? 20;
        const made: DownloadQueueRunner = new DownloadQueueRunner({
            db,
            adapter: "adapter" in options ? options.adapter : adapter,
            storage,
            // Never really waits. A test whose failure never clears stops the loop by pausing it.
            sleep: async (ms) => {
                sleeps.push(ms);
                if (sleeps.length >= maxSleeps) {
                    await made.pause();
                }
            },
        });
        return made;
    }

    async function run() {
        runner.paused = false;
        await runner.kick();
    }

    const status = () => useDownloadStatus.getState().status;

    describe("drained", () => {
        it("downloads every queued song, art first, then stops idle", async () => {
            await queue(db, ["a", "b"]);

            await run();

            expect(await downloadedIds(db)).toEqual(["a", "b"]);
            expect(await countDownloadQueue(db)).toBe(0);
            expect(adapter.fetched).toEqual([art("a"), music("a"), art("b"), music("b")]);
            expect(status()).toMatchObject({ phase: "idle", queuedCount: 0, completedCount: 2, current: undefined });
            expect(sleeps).toEqual([]);
        });

        it("reports progress for the song in flight, and clears it once nothing is", async () => {
            await queue(db, ["a"]);
            const seen: (number | undefined)[] = [];
            const unsubscribe = useDownloadStatus.subscribe((state) => seen.push(state.status.current?.progress));

            await run();
            unsubscribe();

            expect(seen).toContain(0.5);
            expect(status().current).toBeUndefined();
        });

        it("holds the background service while there is work and releases it when the queue drains", async () => {
            adapter.background = fakeHold();
            const holds: boolean[] = [];
            const hold = adapter.background.hold;
            adapter.background.hold = (n) => { holds.push(true); hold(n); };
            await queue(db, ["a"]);

            await run();

            expect(holds.length).toBeGreaterThan(0);
            expect(adapter.background.held).toBe(false);
        });

        it("doesn't fetch art again that an earlier attempt already stored", async () => {
            adapter.stored.add(art("a"));
            await queue(db, ["a"]);

            await run();

            expect(adapter.fetched).toEqual([music("a")]);
            expect(await downloadedIds(db)).toEqual(["a"]);
        });
    });

    describe("skipped", () => {
        it("records a song whose file is already on disk without fetching anything", async () => {
            adapter.stored.add(music("a"));
            await queue(db, ["a", "b"]);

            await run();

            expect(adapter.fetched).toEqual([art("b"), music("b")]);
            expect(await downloadedIds(db)).toEqual(["a", "b"]);
            expect(status().completedCount).toBe(1);
        });

        it("drops a row whose song is gone locally", async () => {
            await queue(db, ["zzz", "a"]);

            await run();

            expect(await countDownloadQueue(db)).toBe(0);
            expect(await downloadedIds(db)).toEqual(["a"]);
        });

        // ShuffullApp#86: a song the server no longer has must not wedge the queue.
        it("drops a 404 without marking it downloaded, and goes on to the next song", async () => {
            adapter.responses.set(music("a"), [{ status: 404 }]);
            await queue(db, ["a", "b"]);

            await run();

            expect(await downloadedIds(db)).toEqual(["b"]);
            expect(await countDownloadQueue(db)).toBe(0);
            expect(status()).toMatchObject({ phase: "idle", skippedCount: 1, completedCount: 1 });
            expect(sleeps).toEqual([]);
        });

        it("drops a song after repeated hash mismatches, backing off between them", async () => {
            adapter.responses.set(music("a"), [{ status: 200, hashMatches: false }]);
            await queue(db, ["a"]);

            await run();

            expect(adapter.fetched.filter(x => x === music("a"))).toHaveLength(MAX_HASH_MISMATCHES);
            expect(sleeps).toHaveLength(MAX_HASH_MISMATCHES - 1);
            expect(await countDownloadQueue(db)).toBe(0);
            expect(await downloadedIds(db)).toEqual([]);
            expect(status().skippedCount).toBe(1);
        });

        it("saves a song without art when the server has none", async () => {
            adapter.responses.set(art("a"), [{ status: 404 }]);
            await queue(db, ["a"]);

            await run();

            expect(await downloadedIds(db)).toEqual(["a"]);
            expect(adapter.stored.has(art("a"))).toBe(false);
        });
    });

    describe("blocked", () => {
        it("stops without touching the queue when the network gate says no", async () => {
            adapter.online = false;
            await queue(db, ["a"]);

            await run();

            expect(adapter.fetched).toEqual([]);
            expect(await countDownloadQueue(db)).toBe(1);
            expect(status()).toMatchObject({ phase: "offline", queuedCount: 1 });
            expect(sleeps).toEqual([]);
        });

        it("stops when no host is set", async () => {
            storage.values.delete(STORAGE_KEYS.HOST_ADDRESS);
            await queue(db, ["a"]);

            await run();

            expect(adapter.fetched).toEqual([]);
            expect(await countDownloadQueue(db)).toBe(1);
        });

        it("starts nothing while paused, and the pause survives a restart", async () => {
            await queue(db, ["a"]);
            await runner.pause();
            expect(storage.values.get(STORAGE_KEYS.DOWNLOADS_PAUSED)).toBe("1");

            const restarted = makeRunner();
            await restarted.start();
            await restarted.kick();
            restarted.dispose();

            expect(adapter.fetched).toEqual([]);
            expect(status()).toMatchObject({ phase: "paused", queuedCount: 1 });
        });

        it("picks up again when the network comes back and the adapter reports it", async () => {
            let onChange: () => void = () => {};
            adapter.watch = (callback) => { onChange = callback; };
            adapter.online = false;
            await queue(db, ["a"]);
            await runner.start();
            await runner.kick();
            expect(adapter.fetched).toEqual([]);

            adapter.online = true;
            onChange();
            await runner.kick();

            expect(await downloadedIds(db)).toEqual(["a"]);
        });
        it("goes round again for work queued while it was already stopping", async () => {
            // Queued after the loop's last look at the queue, while it publishes why it stopped: the kick lands on
            // the run that is ending, which must not leave the song for the watchdog.
            let queuedLate = false;
            const network = adapter.network.bind(adapter);
            adapter.network = async () => {
                if (!queuedLate) {
                    queuedLate = true;
                    await queue(db, ["a"]);
                    void runner.kick();
                }
                return network();
            };

            await run();

            expect(queuedLate).toBe(true);
            expect(await downloadedIds(db)).toEqual(["a"]);
        });
    });

    describe("failed with backoff", () => {
        it("keeps the row through server errors, backing off longer each time, then downloads it", async () => {
            adapter.responses.set(music("a"), [{ status: 503 }, { status: 503 }, { status: 200, hashMatches: true }]);
            await queue(db, ["a"]);

            await run();

            expect(sleeps).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2]);
            expect(await downloadedIds(db)).toEqual(["a"]);
        });

        it("retries the whole song on a transient art failure, before fetching any audio", async () => {
            adapter.responses.set(art("a"), [{ status: 503 }, { status: 200 }]);
            await queue(db, ["a"]);

            await run();

            expect(adapter.fetched).toEqual([art("a"), art("a"), music("a")]);
            expect(sleeps).toEqual([RETRY_BASE_MS]);
            expect(await downloadedIds(db)).toEqual(["a"]);
        });

        it("counts an interrupted download and a throwing adapter as failures, not drops", async () => {
            adapter.responses.set(music("a"), [undefined, { status: 200, hashMatches: true }]);
            const download = adapter.download.bind(adapter);
            let thrown = false;
            adapter.download = async (...args) => {
                if (!thrown && args[1] === "albumart") {
                    thrown = true;
                    throw new Error("disk full");
                }
                return download(...args);
            };
            await queue(db, ["a"]);

            await run();

            expect(sleeps).toHaveLength(2);
            expect(await downloadedIds(db)).toEqual(["a"]);
        });

        // A run of drops is more likely the server than the songs (tools/downloadFailure.ts): past the limit a row is
        // kept at the back of the queue instead, and a song downloading again lets the drops resume.
        it("defers drops past the consecutive limit, then drops them once a song gets through", async () => {
            const dead = ["a", "b", "c", "d", "e", "f"];
            for (const id of dead) {
                adapter.responses.set(music(id), [{ status: 404 }]);
            }
            await queue(db, [...dead, "g"]);

            await run();

            expect(dead.length).toBeGreaterThan(MAX_CONSECUTIVE_DROPS);
            expect(await downloadedIds(db)).toEqual(["g"]);
            expect(await countDownloadQueue(db)).toBe(0);
            expect(status().skippedCount).toBe(dead.length);
            // The deferred row was retried after "g", not before it.
            expect(adapter.fetched.filter(x => x.startsWith("music/"))).toEqual([...dead.map(music), music("g"), music("f")]);
            expect(sleeps).toEqual([RETRY_BASE_MS]);
        });

        it("leaves the deferred row queued while the server keeps refusing everything", async () => {
            for (const id of ["a", "b", "c", "d", "e", "f"]) {
                adapter.responses.set(music(id), [{ status: 404 }]);
            }
            runner = makeRunner({ maxSleeps: 3 });
            await queue(db, ["a", "b", "c", "d", "e", "f"]);

            await run();

            expect((await getDownloadQueueDetails(db, 10)).map(x => x.song.songId)).toEqual(["f"]);
            expect(status().skippedCount).toBe(MAX_CONSECUTIVE_DROPS);
        });
    });

    describe("queueing", () => {
        it("records a playlist's songs already on disk and queues only the rest", async () => {
            await db.insert(playlistSongTable).values([
                { playlistSongId: "p1", playlistId: "pl", songId: "a" },
                { playlistSongId: "p2", playlistId: "pl", songId: "b" },
            ]);
            adapter.stored.add(music("a"));
            runner.paused = true; // only the queueing is under test here

            const result = await runner.addPlaylistToDownloadQueue("pl", DownloadPriority.Medium);

            expect(result).toEqual({ queued: 1, alreadyDownloaded: 1 });
            expect(await downloadedIds(db)).toEqual(["a"]);
            expect((await getDownloadQueueDetails(db, 10)).map(x => x.song.songId)).toEqual(["b"]);
        });

        it("start-up matches the Downloads list to the disk", async () => {
            adapter.stored.add(music("c"));

            await runner.start();

            expect(await downloadedIds(db)).toEqual(["c"]);
        });

        it("does nothing at all on a host with no store", async () => {
            const unsupported = makeRunner({ adapter: undefined });

            await unsupported.start();
            await unsupported.addSongToDownloadQueue("a", DownloadPriority.Medium);
            await unsupported.resume();

            expect(await countDownloadQueue(db)).toBe(0);
            expect(status().phase).toBe("unsupported");
        });
    });
});

describe("desktop download adapter", () => {
    it("reads the store's answer the way the failure rules expect", () => {
        expect(desktopDownloadResult({ ok: true })).toEqual({ status: 200, hashMatches: true });
        expect(desktopDownloadResult({ ok: false, error: "HTTP 404 for music/x.mp3", status: 404 })).toEqual({ status: 404 });
        expect(desktopDownloadResult({ ok: false, error: "integrity check failed", hashMismatch: true })).toEqual({ status: 200, hashMatches: false });
        // A network error, or a shell from before it reported a status: retried, never dropped.
        expect(desktopDownloadResult({ ok: false, error: "fetch failed" })).toBeUndefined();
    });

    it("routes the store's progress events to the fetch that asked for them", async () => {
        let emit: Parameters<DesktopMediaStore["onProgress"]>[0] = () => {};
        const media: DesktopMediaStore = {
            onProgress: (callback) => { emit = callback; return () => {}; },
            download: async (_host, kind, fileName) => {
                emit({ kind, fileName: "other.mp3", received: 1, total: 2 });
                emit({ kind, fileName, received: 3, total: 4 });
                return { ok: true };
            },
            exists: async () => false,
            remove: async () => {},
        };
        const progress: number[] = [];

        const result = await createDesktopDownloadAdapter(media).download("https://api.test", "music", "hasha.mp3", true, (x) => progress.push(x));

        expect(result).toEqual({ status: 200, hashMatches: true });
        expect(progress).toEqual([0.75]);
    });
});
