import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { getFilteredSong, getRandomSongId } from "@/app/services/db/queries/song";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";

/**
 * The pool `skip()` draws the NEXT song from. If a scoped query comes back empty, playback stops with no
 * error anywhere — which is exactly how "tap a song in a playlist, it plays, then silence" presented.
 *
 * Runs the real SQL against an in-memory better-sqlite3, so the json_each/whitelist logic is genuinely
 * exercised rather than mocked.
 */
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
        CREATE TABLE user_songs (
            user_id TEXT NOT NULL,
            song_id TEXT NOT NULL,
            last_played INTEGER NOT NULL,
            version INTEGER NOT NULL,
            like_status INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, song_id)
        );
        CREATE TABLE playlist_songs (
            playlist_song_id TEXT PRIMARY KEY,
            playlist_id TEXT NOT NULL,
            song_id TEXT NOT NULL
        );
        CREATE TABLE song_artists (
            song_artist_id TEXT PRIMARY KEY,
            song_id TEXT NOT NULL,
            artist_id TEXT NOT NULL
        );
        CREATE TABLE song_tags (
            song_tag_id TEXT PRIMARY KEY,
            song_id TEXT NOT NULL,
            tag_id TEXT NOT NULL
        );
        CREATE TABLE downloaded_songs (
            downloaded_song_id TEXT PRIMARY KEY,
            song_id TEXT NOT NULL
        );

        INSERT INTO songs (song_id, file_extension, file_hash, name) VALUES
            ('s1','mp3','h1','In Playlist A'),
            ('s2','mp3','h2','Also In Playlist A'),
            ('s3','mp3','h3','Elsewhere');
        INSERT INTO playlist_songs (playlist_song_id, playlist_id, song_id) VALUES
            ('ps1','pl-a','s1'), ('ps2','pl-a','s2'), ('ps3','pl-b','s3');
        INSERT INTO downloaded_songs (downloaded_song_id, song_id) VALUES ('d1','s2');
    `);
    return drizzle(sqlite) as unknown as GenericDb;
}

describe("scoped next-song pool", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("a playlist scope returns that playlist's songs, so playback can continue", async () => {
        const filters = new SongFilters();
        filters.setSoleFilter(SongFilterType.Playlist, ["pl-a"]);

        const pool = await getFilteredSong(db, filters);
        expect(pool.map((x) => x.songId).sort()).toEqual(["s1", "s2"]);
    });

    it("a playlist scope excludes songs outside it", async () => {
        const filters = new SongFilters();
        filters.setSoleFilter(SongFilterType.Playlist, ["pl-b"]);

        const pool = await getFilteredSong(db, filters);
        expect(pool.map((x) => x.songId)).toEqual(["s3"]);
    });

    it("a disliked song is never picked as the next song", async () => {
        // like_status 3 = Dislike.
        (db as any).$client.exec(`
            INSERT INTO user_songs (user_id, song_id, last_played, version, like_status)
            VALUES ('u','s1',0,0,3)`);

        const filters = new SongFilters();
        filters.setSoleFilter(SongFilterType.Playlist, ["pl-a"]);

        const pool = await getFilteredSong(db, filters);
        expect(pool.map((x) => x.songId)).toEqual(["s2"]);
    });

    it("the downloads scope yields only songs on disk", async () => {
        const filters = new SongFilters();
        filters.localOnly = true;

        const pool = await getFilteredSong(db, filters);
        expect(pool.map((x) => x.songId)).toEqual(["s2"]);
    });

    it("with no scope the whole library is available, so playback never dead-ends", async () => {
        // The unscoped fallback mediaManager now uses instead of returning undefined.
        const songId = await getRandomSongId(db);
        expect(["s1", "s2", "s3"]).toContain(songId);
    });
});
