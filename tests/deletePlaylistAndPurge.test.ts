import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { deletePlaylistAndPurge } from "@/app/services/db/queries/playlist";
import { updateSongs } from "@/app/services/db/queries/song";
import {
    playlistTable,
    playlistSongTable,
    songTable,
    songArtistTable,
    songTagTable,
    userSongTable,
    downloadedSongTable,
} from "@/app/services/db/schema";
import type { Song } from "@/app/services/db/models";

// In-memory SQLite mirroring the tables the purge touches. FK enforcement is off by default in better-sqlite3
// (as in the app at runtime), so we exercise the query's own delete ordering rather than DB cascade.
function makeDb(): GenericDb {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
        CREATE TABLE songs (
            song_id TEXT PRIMARY KEY, file_extension TEXT NOT NULL, file_hash TEXT NOT NULL, name TEXT NOT NULL,
            synced_lyrics TEXT, plain_lyrics TEXT, lyrics_instrumental INTEGER NOT NULL DEFAULT 0,
            lyrics_source TEXT, bpm INTEGER, energy INTEGER, exploratory INTEGER NOT NULL DEFAULT 0,
            tags_stale INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE playlists (
            playlist_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
            percent_until_replayable REAL NOT NULL, version INTEGER NOT NULL, is_exploratory INTEGER NOT NULL DEFAULT 0,
            tags_stale INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE playlist_songs ( playlist_song_id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, song_id TEXT NOT NULL );
        CREATE TABLE song_artists ( song_artist_id TEXT PRIMARY KEY, song_id TEXT NOT NULL, artist_id TEXT NOT NULL );
        CREATE TABLE song_tags ( song_tag_id TEXT PRIMARY KEY, song_id TEXT NOT NULL, tag_id TEXT NOT NULL );
        CREATE TABLE user_songs (
            user_id TEXT NOT NULL, song_id TEXT NOT NULL, last_played INTEGER NOT NULL, version INTEGER NOT NULL,
            like_status INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, song_id)
        );
        CREATE TABLE downloaded_songs ( downloaded_song_id TEXT PRIMARY KEY, song_id TEXT NOT NULL );
    `);
    return drizzle(sqlite) as unknown as GenericDb;
}

function song(id: string, exploratory: boolean): Song {
    return {
        songId: id, fileExtension: "mp3", fileHash: `hash-${id}`, name: `Song ${id}`,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, energy: null, exploratory,
        tagsStale: false,
    };
}

async function addPlaylist(db: GenericDb, playlistId: string, isExploratory: boolean) {
    await db.insert(playlistTable).values([{
        playlistId, userId: "u1", name: playlistId, percentUntilReplayable: 0.9, version: new Date(), isExploratory,
    }]);
}

async function addJoin(db: GenericDb, playlistId: string, songId: string) {
    await db.insert(playlistSongTable).values([{ playlistSongId: `${playlistId}-${songId}`, playlistId, songId }]);
}

async function addChildren(db: GenericDb, songId: string) {
    await db.insert(songArtistTable).values([{ songArtistId: `sa-${songId}`, songId, artistId: "a1" }]);
    await db.insert(songTagTable).values([{ songTagId: `st-${songId}`, songId, tagId: "t1" }]);
    await db.insert(userSongTable).values([{ userId: "u1", songId, lastPlayed: new Date(), version: new Date(), likeStatus: 0 }]);
    await db.insert(downloadedSongTable).values([{ downloadedSongId: `d-${songId}`, songId }]);
}

const exists = async (db: GenericDb, table: any, col: any, value: string) =>
    (await db.select().from(table).where(eq(col, value))).length > 0;

describe("deletePlaylistAndPurge", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("purges an un-kept audition song (rows + children) but keeps promoted ones", async () => {
        await addPlaylist(db, "audition", true);
        await updateSongs(db, [song("kept", false), song("unkept", true)]);
        await addJoin(db, "audition", "kept");
        await addJoin(db, "audition", "unkept");
        await addChildren(db, "unkept");

        const purged = await deletePlaylistAndPurge(db, "audition");

        expect(purged.map((s) => s.songId)).toEqual(["unkept"]);
        expect(await exists(db, playlistTable, playlistTable.playlistId, "audition")).toBe(false);
        expect(await exists(db, songTable, songTable.songId, "unkept")).toBe(false);
        expect(await exists(db, songTable, songTable.songId, "kept")).toBe(true);
        expect(await exists(db, songArtistTable, songArtistTable.songId, "unkept")).toBe(false);
        expect(await exists(db, songTagTable, songTagTable.songId, "unkept")).toBe(false);
        expect(await exists(db, userSongTable, userSongTable.songId, "unkept")).toBe(false);
        expect(await exists(db, downloadedSongTable, downloadedSongTable.songId, "unkept")).toBe(false);
    });

    it("does not purge an audition song still on another playlist", async () => {
        await addPlaylist(db, "audition", true);
        await addPlaylist(db, "keep", false);
        await updateSongs(db, [song("shared", true)]);
        await addJoin(db, "audition", "shared");
        await addJoin(db, "keep", "shared");

        const purged = await deletePlaylistAndPurge(db, "audition");

        expect(purged).toHaveLength(0);
        expect(await exists(db, songTable, songTable.songId, "shared")).toBe(true);
        expect(await exists(db, playlistSongTable, playlistSongTable.playlistId, "keep")).toBe(true);
    });

    it("purges nothing when the playlist is not exploratory", async () => {
        await addPlaylist(db, "normal", false);
        await updateSongs(db, [song("s1", true)]); // even an exploratory song survives a normal-list delete
        await addJoin(db, "normal", "s1");

        const purged = await deletePlaylistAndPurge(db, "normal");

        expect(purged).toHaveLength(0);
        expect(await exists(db, playlistTable, playlistTable.playlistId, "normal")).toBe(false);
        expect(await exists(db, songTable, songTable.songId, "s1")).toBe(true);
    });

    it("is a no-op for a missing playlist", async () => {
        const purged = await deletePlaylistAndPurge(db, "nope");
        expect(purged).toHaveLength(0);
    });
});
