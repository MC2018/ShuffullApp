import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { addDownloadedSong, addDownloadedSongs, getSongDownloadRows } from "@/app/services/db/queries/downloadedSong";
import { countDownloadedSongs } from "@/app/services/db/queries/downloadQueue";
import { updateSongs } from "@/app/services/db/queries/song";
import { downloadedSongTable } from "@/app/services/db/schema";
import { createDiskReconciler, listStoredSongFiles, reconcileDownloadsWithDisk } from "@/app/services/downloader/reconcileDownloads";
import { reconcileDownloads } from "@/app/tools/downloadReconcile";
import type { Song } from "@/app/services/db/models";

// Same harness as downloadQueueQueries.test.ts: the real drizzle query code against an in-memory better-sqlite3 DB.
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
        CREATE TABLE downloaded_songs (downloaded_song_id TEXT PRIMARY KEY, song_id TEXT NOT NULL);
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

const fileName = (x: { fileHash: string; fileExtension: string }) => `${x.fileHash}${x.fileExtension}`;

async function downloadedIds(db: GenericDb): Promise<string[]> {
    return (await db.select({ songId: downloadedSongTable.songId }).from(downloadedSongTable)).map(x => x.songId).sort();
}

describe("reconcileDownloads", () => {
    it("records files without a row and forgets rows without a file, leaving matches alone", () => {
        const result = reconcileDownloads([
            { songId: "on-disk-no-row", fileName: "a.mp3", downloaded: false },
            { songId: "row-no-file", fileName: "b.mp3", downloaded: true },
            { songId: "both", fileName: "c.mp3", downloaded: true },
            { songId: "neither", fileName: "d.mp3", downloaded: false },
        ], new Set(["a.mp3", "c.mp3", "stranger.mp3"]));

        expect(result).toEqual({ record: ["on-disk-no-row"], forget: ["row-no-file"] });
    });

    it("records every song that shares a stored file", () => {
        const result = reconcileDownloads([
            { songId: "x", fileName: "same.mp3", downloaded: false },
            { songId: "y", fileName: "same.mp3", downloaded: false },
        ], new Set(["same.mp3"]));

        expect(result.record).toEqual(["x", "y"]);
    });
});

describe("reconcileDownloadsWithDisk", () => {
    let db: GenericDb;

    beforeEach(async () => {
        db = makeDb();
        await updateSongs(db, [song("1"), song("2"), song("3")]);
    });

    it("makes the downloaded rows match the folder", async () => {
        await addDownloadedSong(db, "2"); // file gone
        await addDownloadedSong(db, "3"); // file there

        const result = await reconcileDownloadsWithDisk(db, async () => ["hash1.mp3", "hash3.mp3", "hash-unknown.mp3"], fileName);

        expect(result).toEqual({ record: ["1"], forget: ["2"] });
        expect(await downloadedIds(db)).toEqual(["1", "3"]);
    });

    it("changes nothing when the folder can't be listed", async () => {
        await addDownloadedSong(db, "2");

        await expect(reconcileDownloadsWithDisk(db, async () => { throw new Error("EACCES"); }, fileName)).rejects.toThrow("EACCES");

        expect(await downloadedIds(db)).toEqual(["2"]);
    });

    it("reads the rows before listing the folder, so a song landing mid-pass keeps its row", async () => {
        // The Downloader moves the file into place, then adds the row. Simulate that happening during the listing:
        // the rows were already read (no row for 1), and the listing sees the file.
        const result = await reconcileDownloadsWithDisk(db, async () => {
            await addDownloadedSong(db, "1");
            return ["hash1.mp3"];
        }, fileName);

        expect(result.forget).toEqual([]);
        expect(await downloadedIds(db)).toEqual(["1"]);
    });

    it("is a no-op, and quiet, when everything already matches", async () => {
        await addDownloadedSong(db, "1");
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

        expect(await reconcileDownloadsWithDisk(db, async () => ["hash1.mp3"], fileName)).toEqual({ record: [], forget: [] });
        expect(log).not.toHaveBeenCalled();
        log.mockRestore();
    });
});

describe("createDiskReconciler", () => {
    let db: GenericDb;

    beforeEach(async () => {
        db = makeDb();
        await updateSongs(db, [song("1")]);
    });

    it("shares one pass between overlapping callers, and runs again once it's done", async () => {
        const listFiles = vi.fn(async () => ["hash1.mp3"]);
        const reconcile = createDiskReconciler(db, listFiles, fileName);

        await Promise.all([reconcile(), reconcile(), reconcile()]);
        expect(listFiles).toHaveBeenCalledTimes(1);
        expect(await downloadedIds(db)).toEqual(["1"]);

        await reconcile();
        expect(listFiles).toHaveBeenCalledTimes(2);
    });

    it("never throws: a folder it can't read leaves the rows alone", async () => {
        await addDownloadedSong(db, "1");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await createDiskReconciler(db, async () => { throw new Error("EACCES"); }, fileName)();

        expect(warn).toHaveBeenCalled();
        expect(await downloadedIds(db)).toEqual(["1"]);
        warn.mockRestore();
    });
});

describe("listStoredSongFiles (desktop)", () => {
    it("lists the store in one call where the shell can", async () => {
        const media = { list: vi.fn(async () => ["a.mp3", "b.mp3"]), exists: vi.fn(async () => true) };

        expect(await listStoredSongFiles(media, ["a.mp3", "c.mp3"])).toEqual(["a.mp3", "b.mp3"]);
        expect(media.exists).not.toHaveBeenCalled();
    });

    it("asks about each local song on a shell built before list existed", async () => {
        const media = { exists: vi.fn(async (_kind: string, name: string) => name !== "c.mp3") };

        expect(await listStoredSongFiles(media, ["a.mp3", "c.mp3"])).toEqual(["a.mp3"]);
        expect(media.exists).toHaveBeenCalledWith("music", "c.mp3");
    });
});

describe("downloaded-song queries", () => {
    let db: GenericDb;

    beforeEach(async () => {
        db = makeDb();
        await updateSongs(db, [song("1"), song("2")]);
    });

    it("addDownloadedSongs skips songs that already have a row, and repeats in the input", async () => {
        await addDownloadedSong(db, "1");
        await addDownloadedSongs(db, ["1", "2", "2"]);
        await addDownloadedSongs(db, []);

        expect(await downloadedIds(db)).toEqual(["1", "2"]);
        expect(await countDownloadedSongs(db)).toBe(2);
    });

    it("records a song once when two paths add it at the same moment", async () => {
        // The download loop and the disk reconcile can both record the same song. A select-then-insert let both
        // see no row and both insert one.
        await Promise.all([addDownloadedSong(db, "1"), addDownloadedSongs(db, ["1", "2"]), addDownloadedSong(db, "2")]);

        expect(await countDownloadedSongs(db)).toBe(2);
        expect(await downloadedIds(db)).toEqual(["1", "2"]);
    });

    it("addDownloadedSongs handles more ids than one statement takes", async () => {
        const many = Array.from({ length: 1200 }, (_, i) => `s${i}`);
        await addDownloadedSongs(db, many);
        expect(await countDownloadedSongs(db)).toBe(1200);
    });

    it("getSongDownloadRows gives one row per song, with its file parts and download flag", async () => {
        await addDownloadedSong(db, "2");
        // A duplicate row (older builds could write one) must not duplicate the song.
        await db.insert(downloadedSongTable).values({ downloadedSongId: "dup", songId: "2" });

        const states = (await getSongDownloadRows(db)).sort((a, b) => a.songId.localeCompare(b.songId));
        expect(states).toEqual([
            { songId: "1", fileHash: "hash1", fileExtension: ".mp3", downloaded: false },
            { songId: "2", fileHash: "hash2", fileExtension: ".mp3", downloaded: true },
        ]);
    });
});
