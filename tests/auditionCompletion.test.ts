import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { getAuditionProgress, getFinishedAuditionToStopFor, getIncompleteAuditionPlaylistId } from "@/app/services/db/queries/playlist";
import { markSongKept, updateSongs } from "@/app/services/db/queries/song";
import { setUserSongLikeStatus, updateUserSongLastPlayed } from "@/app/services/db/queries/userSong";
import { playlistSongTable, playlistTable, userSongTable } from "@/app/services/db/schema";
import type { Song } from "@/app/services/db/models";
import { LikeStatus } from "@/app/enums";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";

// The "N/M evaluated" count and the player's stop-when-done rule, run against the real query layer. mediaManager
// is React-Native-bound and can't load here; what it adds around these two queries is only the order (read
// getIncompleteAuditionPlaylistId BEFORE a start stamps lastPlayed) and the storage of the result, which
// `startSong` below reproduces.

const USER = "u1";
const SERVER_SEED = new Date(-62135596800000); // DateTime.MinValue, how the site seeds a never-played UserSong

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
        CREATE TABLE user_songs (
            user_id TEXT NOT NULL, song_id TEXT NOT NULL, last_played INTEGER NOT NULL, version INTEGER NOT NULL,
            like_status INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, song_id)
        );
    `);
    return drizzle(sqlite) as unknown as GenericDb;
}

function song(id: string, exploratory: boolean): Song {
    return {
        songId: id, fileExtension: "mp3", fileHash: `hash-${id}`, name: `Song ${id}`,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, energy: null, exploratory, tagsStale: false,
    };
}

// A playlist whose songs all start never-played, the way a fresh mix arrives from the server.
async function addPlaylist(db: GenericDb, playlistId: string, isExploratory: boolean, songIds: string[]) {
    await db.insert(playlistTable).values([{
        playlistId, userId: USER, name: playlistId, percentUntilReplayable: 0.9, version: new Date(), isExploratory,
    }]);
    await updateSongs(db, songIds.map(id => song(id, isExploratory)));
    for (const songId of songIds) {
        await db.insert(playlistSongTable).values([{ playlistSongId: `${playlistId}-${songId}`, playlistId, songId }]);
        await db.insert(userSongTable).values([{ userId: USER, songId, lastPlayed: SERVER_SEED, version: SERVER_SEED, likeStatus: 0 }]);
    }
}

function auditionScope(playlistId: string): SongFilters {
    // What the audition playlist's Play button (and tapping a row in it) builds.
    const scope = new SongFilters();
    scope.setSoleFilter(SongFilterType.Playlist, [playlistId]);
    scope.unheardOnly = true;
    return scope;
}

function ordinaryScope(playlistId: string): SongFilters {
    const scope = new SongFilters();
    scope.setSoleFilter(SongFilterType.Playlist, [playlistId]);
    return scope;
}

/** mediaManager.startNewSong: note whether the mix is unfinished, THEN stamp the play. */
async function startSong(db: GenericDb, scope: SongFilters, songId: string, at: Date): Promise<string | undefined> {
    const inProgress = await getIncompleteAuditionPlaylistId(db, USER, scope);
    await updateUserSongLastPlayed(db, USER, songId, at);
    return inProgress;
}

/** mediaManager.skip → stopIfAuditionFinished. */
async function stopsAfterCurrent(db: GenericDb, scope: SongFilters, inProgress: string | undefined): Promise<boolean> {
    return (await getFinishedAuditionToStopFor(db, USER, scope, inProgress)) != undefined;
}

describe("getAuditionProgress", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("counts up as each song starts, without re-opening anything", async () => {
        await addPlaylist(db, "mix", true, ["a", "b", "c"]);
        expect(await getAuditionProgress(db, USER, "mix")).toEqual({ evaluated: 0, total: 3 });

        await updateUserSongLastPlayed(db, USER, "a", new Date("2026-10-22T10:00:00Z"));
        expect(await getAuditionProgress(db, USER, "mix")).toEqual({ evaluated: 1, total: 3 });

        await updateUserSongLastPlayed(db, USER, "b", new Date("2026-10-22T10:04:00Z"));
        expect(await getAuditionProgress(db, USER, "mix")).toEqual({ evaluated: 2, total: 3 });
    });

    it("counts a Like, a Dislike and a Keep as evaluated even before the song is played", async () => {
        await addPlaylist(db, "mix", true, ["a", "b", "c", "d"]);
        await setUserSongLikeStatus(db, USER, "a", LikeStatus.Like);
        await setUserSongLikeStatus(db, USER, "b", LikeStatus.Dislike);
        await markSongKept(db, "c");

        expect(await getAuditionProgress(db, USER, "mix")).toEqual({ evaluated: 3, total: 4 });
    });

    it("is undefined for an ordinary playlist, which has nothing to evaluate", async () => {
        await addPlaylist(db, "classic-rock", false, ["a", "b"]);
        expect(await getAuditionProgress(db, USER, "classic-rock")).toBeUndefined();
    });

    it("is undefined for a playlist that isn't on this device", async () => {
        expect(await getAuditionProgress(db, USER, "gone")).toBeUndefined();
    });
});

describe("stopping when an audition mix is fully evaluated", () => {
    let db: GenericDb;
    beforeEach(() => { db = makeDb(); });

    it("plays on until the last unheard song, then stops after it", async () => {
        await addPlaylist(db, "mix", true, ["a", "b", "c"]);
        const scope = auditionScope("mix");

        let inProgress = await startSong(db, scope, "a", new Date("2026-10-22T10:00:00Z"));
        expect(await stopsAfterCurrent(db, scope, inProgress)).toBe(false);

        inProgress = await startSong(db, scope, "b", new Date("2026-10-22T10:04:00Z"));
        expect(await stopsAfterCurrent(db, scope, inProgress)).toBe(false);

        // "c" is the last one: the mix reads 3/3 the moment it starts, but the stop waits for it to end.
        inProgress = await startSong(db, scope, "c", new Date("2026-10-22T10:08:00Z"));
        expect(await getAuditionProgress(db, USER, "mix")).toEqual({ evaluated: 3, total: 3 });
        expect(inProgress).toBe("mix");
        expect(await stopsAfterCurrent(db, scope, inProgress)).toBe(true);
    });

    it("stops when a Keep from the list finishes the mix while another song plays", async () => {
        await addPlaylist(db, "mix", true, ["a", "b"]);
        const scope = auditionScope("mix");

        const inProgress = await startSong(db, scope, "a", new Date("2026-10-22T10:00:00Z"));
        await markSongKept(db, "b");

        expect(await stopsAfterCurrent(db, scope, inProgress)).toBe(true);
    });

    it("never stops an ordinary playlist, even once every song in it has been heard", async () => {
        await addPlaylist(db, "classic-rock", false, ["a", "b"]);
        const scope = ordinaryScope("classic-rock");

        let inProgress = await startSong(db, scope, "a", new Date("2026-10-22T10:00:00Z"));
        expect(await stopsAfterCurrent(db, scope, inProgress)).toBe(false);
        inProgress = await startSong(db, scope, "b", new Date("2026-10-22T10:04:00Z"));
        expect(await stopsAfterCurrent(db, scope, inProgress)).toBe(false);
    });

    it("plays on through a mix that was already complete when it started", async () => {
        await addPlaylist(db, "mix", true, ["a", "b"]);
        await updateUserSongLastPlayed(db, USER, "a", new Date("2026-10-21T10:00:00Z"));
        await updateUserSongLastPlayed(db, USER, "b", new Date("2026-10-21T10:04:00Z"));
        const scope = auditionScope("mix");

        // Re-listening to a finished mix (or carrying on after the stop) is ordinary listening.
        const inProgress = await startSong(db, scope, "a", new Date("2026-10-22T10:00:00Z"));
        expect(inProgress).toBeUndefined();
        expect(await stopsAfterCurrent(db, scope, inProgress)).toBe(false);
    });

    it("a resume of the last song keeps what was recorded at its first start, or it would never stop", async () => {
        await addPlaylist(db, "mix", true, ["a", "b"]);
        const scope = auditionScope("mix");
        await startSong(db, scope, "a", new Date("2026-10-22T10:00:00Z"));
        const recordedAtStart = await startSong(db, scope, "b", new Date("2026-10-22T10:04:00Z"));

        // The app is killed mid-way through "b" and resumes it. Re-reading now finds the mix complete, because
        // "b" was stamped on its first start - which is why mediaManager doesn't re-read on a resume.
        expect(await getIncompleteAuditionPlaylistId(db, USER, scope)).toBeUndefined();
        expect(await stopsAfterCurrent(db, scope, recordedAtStart)).toBe(true);
    });

    it("doesn't stop on a finished mix's account once the player has moved to another list", async () => {
        await addPlaylist(db, "mix", true, ["a"]);
        await addPlaylist(db, "classic-rock", false, ["x"]);

        const inProgress = await startSong(db, auditionScope("mix"), "a", new Date("2026-10-22T10:00:00Z"));
        expect(await stopsAfterCurrent(db, ordinaryScope("classic-rock"), inProgress)).toBe(false);
    });
});
