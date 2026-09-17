import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { GenericDb } from "@/app/services/db/GenericDb";
import {
    addToDownloadQueue,
    countDownloadQueue,
    countDownloadedSongs,
    getDownloadQueueDetails,
    getFromDownloadQueue,
    isSongInDownloadQueue,
    removeAllFromDownloadQueue,
    removeFromDownloadQueue,
} from "@/app/services/db/queries/downloadQueue";
import { addDownloadedSong } from "@/app/services/db/queries/downloadedSong";
import { getSongsByPlaylist, updateSongs } from "@/app/services/db/queries/song";
import { artistTable, playlistSongTable, songArtistTable } from "@/app/services/db/schema";
import { DownloadPriority } from "@/app/services/db/types";
import type { Song } from "@/app/services/db/models";

// Same harness as songQueries.test.ts: the real drizzle query code against an in-memory better-sqlite3 DB.
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
            energy INTEGER,
            exploratory INTEGER NOT NULL DEFAULT 0,
            tags_stale INTEGER NOT NULL DEFAULT 0
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

function song(id: string, name = `Song ${id}`): Song {
    return {
        songId: id,
        fileExtension: "mp3",
        fileHash: `hash-${id}`,
        name,
        syncedLyrics: null,
        plainLyrics: null,
        lyricsInstrumental: false,
        lyricsSource: null,
        bpm: null,
        energy: null,
        exploratory: false,
        tagsStale: false,
    } as Song;
}

describe("download queue queries", () => {
    let db: GenericDb;

    beforeEach(async () => {
        db = makeDb();
        await updateSongs(db, [song("a"), song("b"), song("c")]);
        await db.insert(artistTable).values([{ artistId: "ar1", name: "Coltrane" }, { artistId: "ar2", name: "Monk" }]);
        await db.insert(songArtistTable).values([
            { songArtistId: "sa1", songId: "a", artistId: "ar1" },
            { songArtistId: "sa2", songId: "a", artistId: "ar2" },
            { songArtistId: "sa3", songId: "b", artistId: "ar2" },
        ]);
    });

    it("counts, checks membership and clears", async () => {
        expect(await countDownloadQueue(db)).toBe(0);
        await addToDownloadQueue(db, ["a", "b"], DownloadPriority.Medium);
        expect(await countDownloadQueue(db)).toBe(2);
        expect(await isSongInDownloadQueue(db, "a")).toBe(true);
        expect(await isSongInDownloadQueue(db, "c")).toBe(false);

        await removeFromDownloadQueue(db, "a");
        expect(await isSongInDownloadQueue(db, "a")).toBe(false);
        expect(await countDownloadQueue(db)).toBe(1);

        await removeAllFromDownloadQueue(db);
        expect(await countDownloadQueue(db)).toBe(0);
    });

    it("re-queueing an already queued song is a no-op (unique song_id)", async () => {
        await addToDownloadQueue(db, ["a"], DownloadPriority.Low);
        await addToDownloadQueue(db, ["a"], DownloadPriority.High);
        expect(await countDownloadQueue(db)).toBe(1);
    });

    it("lists the queue head in the order the Downloader takes it, with artists grouped", async () => {
        await addToDownloadQueue(db, ["a"], DownloadPriority.Low);
        await addToDownloadQueue(db, ["b"], DownloadPriority.High);
        await addToDownloadQueue(db, ["c"], DownloadPriority.Medium);

        const next = await getFromDownloadQueue(db);
        const listed = await getDownloadQueueDetails(db, 10);
        expect(listed.map((x) => x.song.songId)).toEqual(["b", "c", "a"]);
        expect(listed[0].song.songId).toBe(next!.songId);
        // Two artists for "a" collapse into one row, not two.
        expect(listed[2].artists.map((x) => x.name).sort()).toEqual(["Coltrane", "Monk"]);
        expect(listed[1].artists).toEqual([]);
    });

    it("honours the preview limit", async () => {
        await addToDownloadQueue(db, ["a", "b", "c"], DownloadPriority.Medium);
        const listed = await getDownloadQueueDetails(db, 2);
        expect(listed).toHaveLength(2);
        expect(await getDownloadQueueDetails(db, 0)).toEqual([]);
    });

    it("counts downloaded songs", async () => {
        expect(await countDownloadedSongs(db)).toBe(0);
        await addDownloadedSong(db, "a");
        await addDownloadedSong(db, "b");
        expect(await countDownloadedSongs(db)).toBe(2);
    });

    // Regression: this query had no WHERE and a per-artist join, so "Download playlist" enqueued the entire
    // library - one row per (song, artist) - instead of the playlist. Discovered the day the queue became visible.
    it("getSongsByPlaylist returns only that playlist's songs, one row each", async () => {
        await db.insert(playlistSongTable).values([
            { playlistSongId: "ps1", playlistId: "p1", songId: "a" }, // "a" has two artists
            { playlistSongId: "ps2", playlistId: "p1", songId: "c" },
            { playlistSongId: "ps3", playlistId: "p2", songId: "b" },
        ]);
        const songs = await getSongsByPlaylist(db, "p1");
        expect(songs.map((s) => s.songId).sort()).toEqual(["a", "c"]);
        expect(await getSongsByPlaylist(db, "nope")).toEqual([]);
    });
});
