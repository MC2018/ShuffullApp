import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { applySongMetadataEdit, updateSongs } from "@/app/services/db/queries/song";
import { artistTable, songArtistTable, songTable, songTagTable, tagTable, TagType } from "@/app/services/db/schema";
import type { Song, UpdateSongMetadataPayload } from "@/app/services/db/models";

// In-memory SQLite mirroring the tables applySongMetadataEdit touches. Exercises the real query against a
// behaviourally-identical driver (React Native / expo-sqlite is never loaded). See songQueries.test.ts.
function makeDb(): GenericDb {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
        CREATE TABLE songs (
            song_id TEXT PRIMARY KEY, file_extension TEXT NOT NULL, file_hash TEXT NOT NULL, name TEXT NOT NULL,
            synced_lyrics TEXT, plain_lyrics TEXT, lyrics_instrumental INTEGER NOT NULL DEFAULT 0,
            lyrics_source TEXT, bpm INTEGER, energy INTEGER, exploratory INTEGER NOT NULL DEFAULT 0,
            tags_stale INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE artists ( artist_id TEXT PRIMARY KEY, name TEXT NOT NULL );
        CREATE TABLE song_artists ( song_artist_id TEXT PRIMARY KEY, song_id TEXT NOT NULL, artist_id TEXT NOT NULL );
        CREATE TABLE tags ( tag_id TEXT PRIMARY KEY, name TEXT NOT NULL, type INTEGER NOT NULL );
        CREATE TABLE song_tags ( song_tag_id TEXT PRIMARY KEY, song_id TEXT NOT NULL, tag_id TEXT NOT NULL );
    `);
    return drizzle(sqlite) as unknown as GenericDb;
}

function song(id: string, name = `Song ${id}`, bpm: number | null = 120, energy: number | null = 5): Song {
    return {
        songId: id, fileExtension: "mp3", fileHash: `hash-${id}`, name,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null, bpm, energy,
        exploratory: false,
        tagsStale: false,
    };
}

function payload(over: Partial<UpdateSongMetadataPayload> = {}): UpdateSongMetadataPayload {
    return { name: "Edited", bpm: 140, energy: 8, artists: [], tags: [], ...over };
}

async function artistNames(db: GenericDb, songId: string): Promise<string[]> {
    const rows = await db
        .select({ name: artistTable.name })
        .from(songArtistTable)
        .where(eq(songArtistTable.songId, songId))
        .innerJoin(artistTable, eq(artistTable.artistId, songArtistTable.artistId));
    return rows.map((r) => r.name).sort();
}

async function tagNames(db: GenericDb, songId: string): Promise<string[]> {
    const rows = await db
        .select({ name: tagTable.name })
        .from(songTagTable)
        .where(eq(songTagTable.songId, songId))
        .innerJoin(tagTable, eq(tagTable.tagId, songTagTable.tagId));
    return rows.map((r) => r.name).sort();
}

describe("applySongMetadataEdit (optimistic local apply)", () => {
    let db: GenericDb;

    beforeEach(async () => {
        db = makeDb();
        await updateSongs(db, [song("s1")]);
    });

    it("updates scalar fields", async () => {
        await applySongMetadataEdit(db, "s1", payload({ name: "New Title", bpm: 90, energy: 3 }));
        const s = await db.select().from(songTable).where(eq(songTable.songId, "s1"));
        expect(s[0].name).toBe("New Title");
        expect(s[0].bpm).toBe(90);
        expect(s[0].energy).toBe(3);
    });

    it("clears scalar bpm/energy when null", async () => {
        await applySongMetadataEdit(db, "s1", payload({ bpm: null, energy: null }));
        const s = await db.select().from(songTable).where(eq(songTable.songId, "s1"));
        expect(s[0].bpm).toBeNull();
        expect(s[0].energy).toBeNull();
    });

    it("rewrites artists (reuses by name, creates new, drops removed)", async () => {
        // Seed an existing shared artist + an old link.
        await db.insert(artistTable).values({ artistId: "shared-id", name: "Shared" });
        await db.insert(songArtistTable).values({ songArtistId: "old", songId: "s1", artistId: "shared-id" });
        await db.insert(artistTable).values({ artistId: "old-artist", name: "Old" });
        await db.insert(songArtistTable).values({ songArtistId: "old2", songId: "s1", artistId: "old-artist" });

        await applySongMetadataEdit(db, "s1", payload({ artists: ["Shared", "Brand New"] }));

        expect(await artistNames(db, "s1")).toEqual(["Brand New", "Shared"]);
        // "Old" master row still exists (shared rows are never deleted), just unlinked.
        const allArtists = (await db.select().from(artistTable)).map((a) => a.name).sort();
        expect(allArtists).toContain("Old");
    });

    it("dedupes repeated and blank artist entries", async () => {
        await applySongMetadataEdit(db, "s1", payload({ artists: ["Dupe", "Dupe", "  ", "Other"] }));
        expect(await artistNames(db, "s1")).toEqual(["Dupe", "Other"]);
    });

    it("links an existing local tag by (name, type) but skips a brand-new tag", async () => {
        await db.insert(tagTable).values({ tagId: "g1", name: "House", type: TagType.Genre });

        await applySongMetadataEdit(db, "s1", payload({
            tags: [
                { name: "House", type: TagType.Genre },     // exists locally -> linked
                { name: "Nightcore", type: TagType.Genre },  // new -> not linked locally (server creates it)
            ],
        }));

        // Only the existing tag is linked; the new one waits for the next sync.
        expect(await tagNames(db, "s1")).toEqual(["House"]);
    });

    it("does not match a tag of a different type with the same name", async () => {
        await db.insert(tagTable).values({ tagId: "g1", name: "Dark", type: TagType.Mood });
        await applySongMetadataEdit(db, "s1", payload({ tags: [{ name: "Dark", type: TagType.Theme }] }));
        // The local "Dark" is a Mood, not a Theme, so it must not be linked.
        expect(await tagNames(db, "s1")).toEqual([]);
    });

    it("clears tags/artists when given empty lists", async () => {
        await db.insert(artistTable).values({ artistId: "a1", name: "A" });
        await db.insert(songArtistTable).values({ songArtistId: "sa1", songId: "s1", artistId: "a1" });
        await db.insert(tagTable).values({ tagId: "t1", name: "Trance", type: TagType.Genre });
        await db.insert(songTagTable).values({ songTagId: "st1", songId: "s1", tagId: "t1" });

        await applySongMetadataEdit(db, "s1", payload({ artists: [], tags: [] }));

        expect(await artistNames(db, "s1")).toEqual([]);
        expect(await tagNames(db, "s1")).toEqual([]);
    });
});
