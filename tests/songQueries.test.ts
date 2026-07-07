import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { GenericDb } from "@/app/services/db/GenericDb";
import {
    updateSongs,
    getSong,
    getAllSongIds,
    getAllSongDetails,
    getSongDetailsByArtist,
} from "@/app/services/db/queries/song";
import { artistTable, songArtistTable } from "@/app/services/db/schema";
import type { Song } from "@/app/services/db/models";

// The drizzle query helpers accept a GenericDb (the Expo SQLite / transaction type). At runtime they only
// touch the cross-driver query-builder surface (select / insert / delete / from / where), so a
// better-sqlite3-backed drizzle db is behaviourally interchangeable for these pure-SQL operations. We cast
// through `unknown` to satisfy the compile-time type while exercising the real query code against an
// in-memory database. React Native / expo-sqlite is never loaded.
function makeDb(): GenericDb {
    const sqlite = new Database(":memory:");

    // DDL mirroring app/services/db/schema.tsx for the tables these queries touch. boolean columns are
    // 0/1 integers, matching drizzle's encoding.
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
            exploratory INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE artists (
            artist_id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE song_artists (
            song_artist_id TEXT PRIMARY KEY,
            song_id TEXT NOT NULL,
            artist_id TEXT NOT NULL
        );
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
    };
}

// Write artist / join rows through the same drizzle connection used by the queries under test.
// drizzle's insert builder is thenable, so awaiting runs it on the better-sqlite3 driver too.
async function insertArtist(db: GenericDb, artistId: string, name: string) {
    await db.insert(artistTable).values({ artistId, name });
}

async function insertSongArtist(db: GenericDb, songArtistId: string, songId: string, artistId: string) {
    await db.insert(songArtistTable).values({ songArtistId, songId, artistId });
}

describe("song queries against in-memory SQLite", () => {
    let db: GenericDb;

    beforeEach(() => {
        db = makeDb();
    });

    describe("updateSongs + getSong + getAllSongIds", () => {
        it("inserts songs and reads one back by id", async () => {
            await updateSongs(db, [song("s1"), song("s2")]);

            const s1 = await getSong(db, "s1");
            expect(s1?.name).toBe("Song s1");
            expect(s1?.fileHash).toBe("hash-s1");
            expect(s1?.lyricsInstrumental).toBe(false);
        });

        it("returns undefined for a missing song", async () => {
            expect(await getSong(db, "nope")).toBeUndefined();
        });

        it("getAllSongIds returns every inserted id", async () => {
            await updateSongs(db, [song("s1"), song("s2"), song("s3")]);
            const ids = await getAllSongIds(db);
            expect(ids.sort()).toEqual(["s1", "s2", "s3"]);
        });

        it("upserts by deleting then inserting (changed fileHash wins)", async () => {
            await updateSongs(db, [song("s1")]);
            const replaced = { ...song("s1", "Renamed"), fileHash: "new-hash" };
            await updateSongs(db, [replaced]);

            const s1 = await getSong(db, "s1");
            expect(s1?.name).toBe("Renamed");
            expect(s1?.fileHash).toBe("new-hash");
            expect((await getAllSongIds(db)).length).toBe(1); // no duplicate row
        });

        it("is a no-op for an empty list", async () => {
            await updateSongs(db, []);
            expect(await getAllSongIds(db)).toEqual([]);
        });
    });

    describe("song-details assembly (artist grouping)", () => {
        it("getAllSongDetails groups multiple artists under one song", async () => {
            await updateSongs(db, [song("s1", "Alpha")]);
            await insertArtist(db, "a1", "Artist One");
            await insertArtist(db, "a2", "Artist Two");
            await insertSongArtist(db, "sa1", "s1", "a1");
            await insertSongArtist(db, "sa2", "s1", "a2");

            const details = await getAllSongDetails(db);
            expect(details).toHaveLength(1);
            expect(details[0].song.songId).toBe("s1");
            expect(details[0].artists.map(a => a.artistId).sort()).toEqual(["a1", "a2"]);
        });

        it("getAllSongDetails yields an empty artist list for songs with no artists", async () => {
            await updateSongs(db, [song("s1")]);
            const details = await getAllSongDetails(db);
            expect(details).toHaveLength(1);
            expect(details[0].artists).toEqual([]);
        });

        it("getSongDetailsByArtist returns only that artist's songs, alphabetised", async () => {
            await updateSongs(db, [song("s1", "Zulu"), song("s2", "Alpha"), song("s3", "Mike")]);
            await insertArtist(db, "a1", "Target");
            await insertArtist(db, "a2", "Other");
            await insertSongArtist(db, "sa1", "s1", "a1");
            await insertSongArtist(db, "sa2", "s2", "a1");
            await insertSongArtist(db, "sa3", "s3", "a2"); // not the target artist

            const details = await getSongDetailsByArtist(db, "a1");
            expect(details.map(d => d.song.name)).toEqual(["Alpha", "Zulu"]);
        });

        it("getSongDetailsByArtist returns empty for an unknown artist", async () => {
            await updateSongs(db, [song("s1")]);
            expect(await getSongDetailsByArtist(db, "ghost")).toEqual([]);
        });
    });
});
