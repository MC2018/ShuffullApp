import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import type { Song } from "@/app/services/db/models";
import {
    applyAutoDownloadPlan,
    countAutoDownloadPending,
    getAutoDownloadSettings,
    saveAutoDownloadSettings,
} from "@/app/services/db/queries/autoDownload";
import { addToDownloadQueue } from "@/app/services/db/queries/downloadQueue";
import { addDownloadedSong, recordQueuedDownload } from "@/app/services/db/queries/downloadedSong";
import { reconcileAutoDownloads } from "@/app/services/downloader/reconcileAutoDownloads";
import { pickNextDownload } from "@/app/services/downloader/pickNextDownload";
import { AUTO_DOWNLOAD_DELAY_MS, AVERAGE_SONG_BYTES } from "@/app/tools/autoDownloads";
import { DownloadPriority } from "@/app/services/db/types";

// ShuffullApp#225 against a real schema: the app's migrations (0037 included) on an in-memory better-sqlite3 DB,
// driven through the same query code the app runs.
const MIGRATIONS = path.resolve(__dirname, "../app/services/db/drizzle");
const USER = "u1";
const T0 = Date.UTC(2026, 10, 23, 12);
const MINUTE = 60 * 1000;
const GB = 1024 ** 3;

let sqlite: Database.Database;
let db: GenericDb;

beforeEach(() => {
    sqlite = new Database(":memory:");
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
    db = drizzle(sqlite) as unknown as GenericDb;
    sqlite.exec(`INSERT INTO users (user_id, username, version) VALUES ('${USER}', 'max', 0)`);
});

function addSong(songId: string, opts: { likeStatus?: number; exploratory?: boolean; fileHash?: string; userId?: string } = {}) {
    sqlite.prepare("INSERT INTO songs (song_id, file_extension, file_hash, name, exploratory) VALUES (?, 'mp3', ?, ?, ?)")
        .run(songId, opts.fileHash ?? `hash-${songId}`, `Song ${songId}`, opts.exploratory ? 1 : 0);
    sqlite.prepare("INSERT INTO user_songs (user_id, song_id, last_played, version, like_status) VALUES (?, ?, ?, 0, ?)")
        .run(opts.userId ?? USER, songId, T0 - 1000, opts.likeStatus ?? 0);
}

const setLike = (songId: string, likeStatus: number) =>
    sqlite.prepare("UPDATE user_songs SET like_status = ? WHERE song_id = ? AND user_id = ?").run(likeStatus, songId, USER);

const rows = (table: string) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY song_id`).all() as Record<string, unknown>[];
const count = (table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function reconcile(nowMs: number, protectedIds: string[] = []) {
    const deleted: string[] = [];
    const run = reconcileAutoDownloads({
        db,
        userId: USER,
        nowMs,
        protectedIds: new Set(protectedIds),
        deleteFiles: async (song: Song) => {
            deleted.push(song.songId);
        },
    });
    return run.then((result) => ({ ...result, deleted }));
}

describe("reconcileAutoDownloads", () => {
    it("does nothing at all with the default settings (Off), on an install with downloads", async () => {
        addSong("a", { likeStatus: 2 });
        await addDownloadedSong(db, "a");
        const result = await reconcile(T0);
        expect(result).toEqual({ enqueued: 0, removed: 0, waiting: 0, deleted: [] });
        expect(rows("auto_download_pending")).toEqual([]);
        expect(count("auto_download_settings")).toBe(0);
    });

    it("a like queues an auto download only after it has held for 10 minutes", async () => {
        await saveAutoDownloadSettings(db, USER, { tier: "liked" });
        addSong("liked", { likeStatus: 1 });
        addSong("neutral");
        addSong("disliked", { likeStatus: 3 });

        expect(await reconcile(T0)).toMatchObject({ enqueued: 0, waiting: 1 });
        expect(rows("download_queue")).toEqual([]);
        expect(await countAutoDownloadPending(db)).toEqual({ add: 1, remove: 0 });

        expect(await reconcile(T0 + 9 * MINUTE)).toMatchObject({ enqueued: 0, waiting: 1 });
        expect(await reconcile(T0 + AUTO_DOWNLOAD_DELAY_MS)).toMatchObject({ enqueued: 1, waiting: 0 });
        expect(rows("download_queue")).toEqual([expect.objectContaining({ song_id: "liked", source: "auto", priority: DownloadPriority.Low })]);
        expect(rows("auto_download_pending")).toEqual([]);
    });

    it("an un-like inside the window leaves nothing queued and no pending row", async () => {
        await saveAutoDownloadSettings(db, USER, { tier: "liked" });
        addSong("a", { likeStatus: 1 });
        await reconcile(T0);
        setLike("a", 0);
        expect(await reconcile(T0 + 5 * MINUTE)).toMatchObject({ enqueued: 0, waiting: 0 });
        expect(await reconcile(T0 + 30 * MINUTE)).toMatchObject({ enqueued: 0, waiting: 0 });
        expect(rows("download_queue")).toEqual([]);
        expect(rows("auto_download_pending")).toEqual([]);
    });

    it("a dislike removes the auto download and its files only after 10 minutes; undone in time, nothing is lost", async () => {
        await saveAutoDownloadSettings(db, USER, { tier: "liked" });
        addSong("a", { likeStatus: 1 });
        await addToDownloadQueue(db, ["a"], DownloadPriority.Low, "auto");
        await recordQueuedDownload(db, "a", "auto");
        expect(rows("downloaded_songs")).toEqual([expect.objectContaining({ song_id: "a", source: "auto" })]);

        // Mis-tap, then undo.
        setLike("a", 3);
        expect(await reconcile(T0)).toMatchObject({ removed: 0, waiting: 1 });
        setLike("a", 1);
        expect(await reconcile(T0 + 4 * MINUTE)).toMatchObject({ removed: 0, waiting: 0, deleted: [] });

        // Meant it this time.
        setLike("a", 3);
        await reconcile(T0 + 5 * MINUTE);
        expect(await reconcile(T0 + 14 * MINUTE)).toMatchObject({ removed: 0, deleted: [] });
        expect(await reconcile(T0 + 15 * MINUTE)).toMatchObject({ removed: 1, deleted: ["a"] });
        expect(rows("downloaded_songs")).toEqual([]);
    });

    it("never removes a hand-picked download, whatever the rules say", async () => {
        addSong("mine", { likeStatus: 3 });
        await addDownloadedSong(db, "mine");
        addSong("mine-queued");
        await addToDownloadQueue(db, ["mine-queued"], DownloadPriority.Medium);
        await reconcile(T0);
        expect(await reconcile(T0 + 60 * MINUTE)).toMatchObject({ removed: 0, waiting: 0, deleted: [] });
        expect(rows("downloaded_songs")).toHaveLength(1);
        expect(rows("download_queue")).toHaveLength(1);
    });

    it("turning the rules Off winds auto downloads down after the delay, and leaves hand-picked ones", async () => {
        addSong("auto");
        addSong("mine");
        await addDownloadedSong(db, "auto", "auto");
        await addDownloadedSong(db, "mine");
        addSong("auto-queued");
        await addToDownloadQueue(db, ["auto-queued"], DownloadPriority.Low, "auto");

        await reconcile(T0);
        const result = await reconcile(T0 + AUTO_DOWNLOAD_DELAY_MS);
        expect(result).toMatchObject({ removed: 2, deleted: ["auto"] });
        expect(rows("downloaded_songs")).toEqual([expect.objectContaining({ song_id: "mine" })]);
        expect(rows("download_queue")).toEqual([]);
    });

    it("never removes a song the player has lined up", async () => {
        addSong("playing");
        await addDownloadedSong(db, "playing", "auto");
        await reconcile(T0, ["playing"]);
        expect(await reconcile(T0 + 60 * MINUTE, ["playing"])).toMatchObject({ removed: 0, waiting: 0 });
        expect(rows("downloaded_songs")).toHaveLength(1);
    });

    it("keeps a file another download still uses", async () => {
        addSong("old-copy", { fileHash: "shared" });
        addSong("new-copy", { fileHash: "shared" });
        await addDownloadedSong(db, "old-copy", "auto");
        await addDownloadedSong(db, "new-copy");
        await reconcile(T0);
        expect(await reconcile(T0 + AUTO_DOWNLOAD_DELAY_MS)).toMatchObject({ removed: 1, deleted: [] });
    });

    it("never wants a song the user hid as a duplicate", async () => {
        await saveAutoDownloadSettings(db, USER, { tier: "all" });
        addSong("a");
        addSong("hidden");
        sqlite.prepare(`INSERT INTO song_duplicate_reports (report_id, user_id, song_id, kind, hidden_song_id, status, created_at)
                        VALUES ('r1', ?, 'hidden', 'differentVersion', 'hidden', 'pending', 0)`).run(USER);
        await reconcile(T0);
        await reconcile(T0 + AUTO_DOWNLOAD_DELAY_MS);
        expect(rows("download_queue").map((x) => x.song_id)).toEqual(["a"]);
    });

    it("reads like status for this user only", async () => {
        await saveAutoDownloadSettings(db, USER, { tier: "loved" });
        sqlite.exec("INSERT INTO users (user_id, username, version) VALUES ('u2', 'someone', 0)");
        addSong("theirs", { likeStatus: 2, userId: "u2" });
        await reconcile(T0);
        expect(await reconcile(T0 + AUTO_DOWNLOAD_DELAY_MS)).toMatchObject({ enqueued: 0 });
    });

    it("queues chosen playlists and the latest mix weeks", async () => {
        sqlite.exec(`INSERT INTO playlists (playlist_id, user_id, name, percent_until_replayable, version, is_exploratory) VALUES
            ('trip', '${USER}', 'Road trip', 0.5, 0, 0),
            ('mix-new', '${USER}', 'Discover Mix · Nov 23', 0.5, 0, 1),
            ('mix-old', '${USER}', 'Discover Mix · Nov 16', 0.5, 0, 1)`);
        for (const id of ["t", "n", "o"]) {
            addSong(id, { exploratory: id !== "t" });
        }
        sqlite.exec(`INSERT INTO playlist_songs (playlist_song_id, playlist_id, song_id) VALUES
            ('1', 'trip', 't'), ('2', 'mix-new', 'n'), ('3', 'mix-old', 'o')`);
        await saveAutoDownloadSettings(db, USER, { playlistIds: ["trip"], mixWeeks: 1 });
        await reconcile(T0);
        await reconcile(T0 + AUTO_DOWNLOAD_DELAY_MS);
        expect(rows("download_queue").map((x) => x.song_id)).toEqual(["n", "t"]);
    });
});

describe("applyAutoDownloadPlan", () => {
    it("leaves a song the user took over by hand since the plan was made", async () => {
        addSong("a");
        await addDownloadedSong(db, "a", "auto");
        await addDownloadedSong(db, "a"); // the user downloaded it by hand meanwhile
        const removed = await applyAutoDownloadPlan(db, { insertPending: [], deletePending: [], enqueue: [], remove: ["a"] });
        expect(removed).toEqual([]);
        expect(rows("downloaded_songs")).toEqual([expect.objectContaining({ song_id: "a", source: "manual" })]);
    });
});

describe("recordQueuedDownload", () => {
    it("records the source the queue row has when the file lands, not the one it had when the download started", async () => {
        addSong("a");
        await addToDownloadQueue(db, ["a"], DownloadPriority.Low, "auto");
        await addToDownloadQueue(db, ["a"], DownloadPriority.Medium); // taken over by hand mid-download
        await recordQueuedDownload(db, "a", "auto");
        expect(rows("downloaded_songs")).toEqual([expect.objectContaining({ song_id: "a", source: "manual" })]);
        expect(rows("download_queue")).toEqual([]);
    });

    it("falls back to the source it was given when the queue row is gone", async () => {
        addSong("a");
        await recordQueuedDownload(db, "a", "auto");
        expect(rows("downloaded_songs")).toEqual([expect.objectContaining({ song_id: "a", source: "auto" })]);
    });
});

describe("auto-download settings", () => {
    it("save per user and keep the fields not changed", async () => {
        await saveAutoDownloadSettings(db, USER, { tier: "library", playlistIds: ["p1", "p2"] });
        await saveAutoDownloadSettings(db, USER, { mixWeeks: 3 });
        expect(await getAutoDownloadSettings(db, USER)).toMatchObject({ tier: "library", playlistIds: ["p1", "p2"], mixWeeks: 3 });
        expect((await getAutoDownloadSettings(db, "u2")).tier).toBe("off");
    });
});

describe("pickNextDownload: the free-space floor", () => {
    beforeEach(() => {
        sqlite.prepare("INSERT INTO local_session_data (user_id, actively_download, token, expiration) VALUES (?, 1, 't', ?)")
            .run(USER, Date.now() + 60 * MINUTE);
        for (const songId of ["mine", "auto", "mine-low"]) {
            addSong(songId);
        }
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("always lets a hand-picked download go, even with no space to spare", async () => {
        await addToDownloadQueue(db, ["mine"], DownloadPriority.Medium);
        expect(await pickNextDownload(db, async () => 0)).toMatchObject({ row: { songId: "mine" }, lowSpace: false });
    });

    it("lets an auto download go when it leaves the floor free", async () => {
        await addToDownloadQueue(db, ["auto"], DownloadPriority.Low, "auto");
        expect(await pickNextDownload(db, async () => 6 * GB)).toMatchObject({ row: { songId: "auto" }, lowSpace: false });
    });

    it("holds auto downloads below the floor, but a hand-picked one behind them still goes", async () => {
        await addToDownloadQueue(db, ["auto"], DownloadPriority.Low, "auto");
        expect(await pickNextDownload(db, async () => 5 * GB)).toEqual({ row: undefined, lowSpace: true });

        await addToDownloadQueue(db, ["mine-low"], DownloadPriority.Low);
        sqlite.exec("UPDATE download_queue SET download_queue_id = 'zzz' WHERE song_id = 'mine-low'"); // queued after
        expect(await pickNextDownload(db, async () => 5 * GB)).toMatchObject({ row: { songId: "mine-low" }, lowSpace: false });
    });

    it("uses this device's floor for the signed-in user", async () => {
        await saveAutoDownloadSettings(db, USER, { freeFloorBytes: 1 * GB });
        await addToDownloadQueue(db, ["auto"], DownloadPriority.Low, "auto");
        expect(await pickNextDownload(db, async () => 1 * GB + AVERAGE_SONG_BYTES)).toMatchObject({ row: { songId: "auto" } });
        expect(await pickNextDownload(db, async () => 1 * GB + AVERAGE_SONG_BYTES - 1)).toMatchObject({ row: undefined, lowSpace: true });
    });

    it("fails closed when free space can't be read", async () => {
        await addToDownloadQueue(db, ["auto"], DownloadPriority.Low, "auto");
        expect(await pickNextDownload(db, async () => undefined)).toEqual({ row: undefined, lowSpace: true });
        expect(await pickNextDownload(db, async () => { throw new Error("statfs failed"); })).toEqual({ row: undefined, lowSpace: true });
    });
});
