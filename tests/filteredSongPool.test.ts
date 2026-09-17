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

    /**
     * Audition cohorts exist to give every track ONE first listen, so they draw only from never-played songs.
     * "Never played" has two shapes in this schema: no user_songs row at all, and the row the server seeds
     * with DateTime.MinValue — a large NEGATIVE epoch, not null and not zero. The old shuffle checked
     * `lastPlayed != null`, which no seeded row ever satisfies, so the never-played branch never ran.
     */
    describe("audition (unheard-only) narrowing", () => {
        const played = (songId: string, at: number) =>
            `INSERT INTO user_songs (user_id, song_id, last_played, version, like_status) VALUES ('u','${songId}',${at},0,0)`;
        const MIN_VALUE = -62135629200000; // C# DateTime.MinValue as ms since epoch — the server's "never".

        it("plays only never-played songs (no user_songs row counts as never)", async () => {
            (db as any).$client.exec(played("s1", 1750000000000));

            const filters = new SongFilters();
            filters.setSoleFilter(SongFilterType.Playlist, ["pl-a"]);
            filters.unheardOnly = true;

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId)).toEqual(["s2"]);
        });

        it("treats a DateTime.MinValue seed as never played, not as played long ago", async () => {
            (db as any).$client.exec(played("s1", 1750000000000));
            (db as any).$client.exec(played("s2", MIN_VALUE));

            const filters = new SongFilters();
            filters.setSoleFilter(SongFilterType.Playlist, ["pl-a"]);
            filters.unheardOnly = true;

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId)).toEqual(["s2"]);
        });

        it("leaves an ordinary playlist alone — everything stays in the pool", async () => {
            (db as any).$client.exec(played("s1", 1750000000000));

            const filters = new SongFilters();
            filters.setSoleFilter(SongFilterType.Playlist, ["pl-a"]);

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId).sort()).toEqual(["s1", "s2"]);
        });

        it("falls back to the whole playlist once the cohort is fully heard, rather than stalling playback", async () => {
            (db as any).$client.exec(played("s1", 1750000000000));
            (db as any).$client.exec(played("s2", 1750000001000));

            const filters = new SongFilters();
            filters.setSoleFilter(SongFilterType.Playlist, ["pl-a"]);
            filters.unheardOnly = true;

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId).sort()).toEqual(["s1", "s2"]);
        });

        it("is cleared by setSoleFilter, so it cannot leak out of an audition session", () => {
            const filters = new SongFilters();
            filters.unheardOnly = true;
            filters.setSoleFilter(SongFilterType.Playlist, ["pl-b"]);

            expect(filters.unheardOnly).toBe(false);
        });
    });

    /**
     * An unrated song cannot be shown to fall inside a requested energy band, so it must not match one. The
     * original condition led with `s.energy IS NULL OR ...`, which short-circuited the band entirely: an energy
     * jam admitted every untagged song, and because those sort first under ORDER BY last_played ASC the 500-row
     * pool ended up holding nothing but unknown-energy songs.
     */
    describe("energy band", () => {
        beforeEach(() => {
            // s1..s3 from makeDb have no energy; these two are the only rated songs.
            (db as any).$client.exec(`
                INSERT INTO songs (song_id, file_extension, file_hash, name, energy) VALUES
                    ('e5','mp3','h5','Energy Five',5),
                    ('e9','mp3','h9','Energy Nine',9)`);
        });

        it("excludes unknown-energy songs once a band is set", async () => {
            const filters = new SongFilters();
            filters.energyMin = 4;
            filters.energyMax = 6;

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId)).toEqual(["e5"]);
        });

        it("excludes unknown-energy songs when only a lower bound is set", async () => {
            const filters = new SongFilters();
            filters.energyMin = 4;

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId).sort()).toEqual(["e5", "e9"]);
        });

        it("excludes unknown-energy songs when only an upper bound is set", async () => {
            const filters = new SongFilters();
            filters.energyMax = 6;

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId)).toEqual(["e5"]);
        });

        it("keeps unknown-energy songs eligible while no bound is set", async () => {
            const filters = new SongFilters();

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId).sort()).toEqual(["e5", "e9", "s1", "s2", "s3"]);
        });
    });

    /**
     * Audition songs are unvetted and carry no tags, so in general shuffle they match every tag-less filter and
     * crowd out the real library -- on one device 377 of a 500-song pool were audition tracks. They must stay
     * reachable through the playlist scope every audition play path sets, and nowhere else.
     */
    describe("audition songs outside their cohort", () => {
        beforeEach(() => {
            (db as any).$client.exec(`
                INSERT INTO songs (song_id, file_extension, file_hash, name, exploratory, energy)
                    VALUES ('x1','mp3','hx','Audition Track',1,5);
                INSERT INTO playlist_songs (playlist_song_id, playlist_id, song_id) VALUES ('psx','pl-x','x1');
                INSERT INTO song_tags (song_tag_id, song_id, tag_id) VALUES ('stx','x1','g1')`);
        });

        it("are excluded from an unscoped shuffle", async () => {
            const pool = await getFilteredSong(db, new SongFilters());
            expect(pool.map((x) => x.songId)).not.toContain("x1");
        });

        it("are excluded from a genre scope, even when they carry that tag", async () => {
            const filters = new SongFilters();
            filters.setSoleFilter(SongFilterType.Genre, ["g1"]);

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId)).not.toContain("x1");
        });

        it("are excluded from an energy band they would otherwise match", async () => {
            const filters = new SongFilters();
            filters.energyMin = 4;
            filters.energyMax = 6;

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId)).not.toContain("x1");
        });

        it("remain playable when scoped to their audition playlist", async () => {
            const filters = new SongFilters();
            filters.setSoleFilter(SongFilterType.Playlist, ["pl-x"]);

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId)).toEqual(["x1"]);
        });

        it("still play under the audition cohort's unheard-only narrowing", async () => {
            const filters = new SongFilters();
            filters.setSoleFilter(SongFilterType.Playlist, ["pl-x"]);
            filters.unheardOnly = true;

            const pool = await getFilteredSong(db, filters);
            expect(pool.map((x) => x.songId)).toEqual(["x1"]);
        });
    });
});
