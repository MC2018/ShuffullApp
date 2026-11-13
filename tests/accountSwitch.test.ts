import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import type { Song } from "@/app/services/db/models";
import { adoptSongCache, claimSongCache, SONG_CACHE_STORAGE_KEYS, type AccountSwitchStorage } from "@/app/services/auth/accountSwitch";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { RequestType } from "@/app/enums";
import { getAllSongDetails, getRandomSongId, updateSongs } from "@/app/services/db/queries/song";
import { getRequests } from "@/app/services/db/queries/request";
import { addGenreJam, getGenreJams } from "@/app/services/db/queries/genreJam";
import { FEED_START, playlistsToFetch } from "@/app/services/sync-manager/syncLogic";
import {
    artistTable, deadLetterRequestTable, downloadedSongTable, downloadQueueTable, genreJamTable, listenStatTable,
    listenTable, localSessionDataTable, playlistSongTable, playlistTable, playNextIntentTable, recentlyPlayedSongTable,
    requestTable, songArtistTable, songTable, songTagTable, tagTable, userSongTable, userTable,
} from "@/app/services/db/schema";

const A = "user-a";
const B = "user-b";
const HOST = "https://shuffull-api.example";
const SYNCED_AT = new Date("2026-11-01T00:00:00Z");

function makeDb(): GenericDb {
    const sqlite = new Database(":memory:");
    // Off on the device too (expo-sqlite never turns it on); the clear relies on nothing cascading.
    sqlite.pragma("foreign_keys = OFF");
    migrate(drizzle(sqlite), { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return drizzle(sqlite) as unknown as GenericDb;
}

function makeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    const storage: AccountSwitchStorage = {
        getItem: async key => map.get(key) ?? null,
        setItem: async (key, value) => { map.set(key, value); },
        removeItem: async key => { map.delete(key); },
    };
    return { map, storage };
}

function song(songId: string, fileHash = `hash-${songId}`): Song {
    return {
        songId, fileExtension: "mp3", fileHash, name: `Song ${songId}`,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, heaviness: null, exploratory: false, tagsStale: false, hookStartPercent: null,
    };
}

// What an account's sync leaves behind: its songs and everything shared that describes them, plus its own rows.
async function seedLibrary(db: GenericDb, userId: string, songs: Song[]) {
    await db.insert(userTable).values({ userId, username: userId, version: SYNCED_AT, isCurator: false });
    await db.insert(localSessionDataTable).values({ userId, activelyDownload: false, token: "t", expiration: SYNCED_AT });
    await updateSongs(db, songs);
    await db.insert(artistTable).values({ artistId: `artist-${userId}`, name: `Artist ${userId}` });
    await db.insert(tagTable).values({ tagId: `tag-${userId}`, name: `Tag ${userId}`, type: 0 });
    await db.insert(playlistTable).values({
        playlistId: `playlist-${userId}`, userId, name: "Mix", percentUntilReplayable: 0.5, version: SYNCED_AT,
    });
    for (const s of songs) {
        await db.insert(songArtistTable).values({ songArtistId: `sa-${s.songId}`, songId: s.songId, artistId: `artist-${userId}` });
        await db.insert(songTagTable).values({ songTagId: `st-${s.songId}`, songId: s.songId, tagId: `tag-${userId}` });
        await db.insert(userSongTable).values({ userId, songId: s.songId, lastPlayed: SYNCED_AT, version: SYNCED_AT });
        await db.insert(playlistSongTable).values({ playlistSongId: `ps-${s.songId}`, playlistId: `playlist-${userId}`, songId: s.songId });
    }
    await db.insert(downloadedSongTable).values({ downloadedSongId: `dl-${songs[0].songId}`, songId: songs[0].songId });
    await db.insert(downloadQueueTable).values({ downloadQueueId: `q-${songs[1].songId}`, songId: songs[1].songId, priority: 1 });
    await db.insert(recentlyPlayedSongTable).values({
        recentlyPlayedSongId: `rp-${songs[0].songId}`, songId: songs[0].songId, timestampSeconds: 12, lastPlayed: SYNCED_AT,
    });
}

// Decisions A made that the server doesn't have yet, and A's other per-user rows.
async function seedUnsentDecisions(db: GenericDb, userId: string, songId: string) {
    await db.insert(requestTable).values([
        { requestId: "like", timeRequested: SYNCED_AT, requestType: RequestType.SetSongLikeStatus, userId, songId, likeStatus: 1 },
        { requestId: "keep", timeRequested: SYNCED_AT, requestType: RequestType.SongRetag, userId, songId, payload: { model: "weak" } },
        {
            requestId: "listen", timeRequested: SYNCED_AT, requestType: RequestType.RecordListen, userId, songId,
            payload: {
                listenId: "listen", songId, startedAt: SYNCED_AT.toISOString(), endedAt: SYNCED_AT.toISOString(),
                secondsListened: 90, songDurationSeconds: 180, endReason: "finished", context: "playlist",
                playlistId: null, platform: "android", userId,
            },
        },
    ]);
    await db.insert(deadLetterRequestTable).values({
        requestId: "dead", requestType: RequestType.SongRetag, userId, songId, timeRequested: SYNCED_AT,
        deadLetteredAt: SYNCED_AT, reason: "not in your library",
        request: { requestId: "dead", requestType: RequestType.SongRetag, userId, songId, timeRequested: SYNCED_AT.toISOString() },
    });
    await db.insert(listenTable).values({
        listenId: "open-listen", userId, songId, startedAt: SYNCED_AT, secondsListened: 30, songDurationSeconds: 180,
        context: "other", checkpointedAt: SYNCED_AT,
    });
    await db.insert(listenStatTable).values({
        userId, songId, plays: 3, skips: 1, averageSecondsListened: 100, completionPercent: 55, lastPlayed: SYNCED_AT,
        recentQuickSkips: 0, maybeDrop: false,
    });
    await db.insert(playNextIntentTable).values({ userId, externalSongId: "yt-1", title: "Next", createdAt: SYNCED_AT });
    await db.insert(genreJamTable).values(jam("jam", userId));
}

const NO_FILTERS = { artistIds: [], playlistIds: [], genreIds: [], timePeriodIds: [], languageIds: [], moodIds: [], themeIds: [] };

// A saved genre jam. A null user is one made before jams had an account (ShuffullApp#199).
function jam(genreJamId: string, userId: string | null) {
    return { genreJamId, userId, name: `Jam ${genreJamId}`, whitelists: NO_FILTERS, blacklists: NO_FILTERS, heavinessMin: null, heavinessMax: null };
}

const jamIds = async (db: GenericDb, userId: string) => (await getGenreJams(db, userId)).map(x => x.genreJamId);

async function count(db: GenericDb, table: SQLiteTable): Promise<number> {
    return (await db.select().from(table)).length;
}

describe("claimSongCache (ShuffullApp#193)", () => {
    let db: GenericDb;
    let deleted: Song[];
    let playbackStops: number;
    let settleDownloads: () => Promise<boolean>;
    let stopSync: () => Promise<void>;
    const deps = (storage: AccountSwitchStorage) => ({
        db,
        storage,
        stopSync: () => stopSync(),
        stopPlayback: async () => { playbackStops++; },
        settleDownloads: () => settleDownloads(),
        deleteSongFiles: async (s: Song) => { deleted.push(s); },
    });

    beforeEach(async () => {
        db = makeDb();
        deleted = [];
        playbackStops = 0;
        settleDownloads = async () => true;
        stopSync = async () => {};
        // a1 (downloaded) and a2 (queued) share one audio file, so it is deleted once. a3 was only streamed: no file.
        await seedLibrary(db, A, [song("a1", "shared"), song("a2", "shared"), song("a3")]);
    });

    it("A then B: the Songs tab and shuffle hold only B's songs, and A's files are deleted", async () => {
        const { map, storage } = makeStorage({
            [STORAGE_KEYS.SONG_CACHE_USER_ID]: A,
            [STORAGE_KEYS.SONG_CACHE_HOST]: HOST,
            [STORAGE_KEYS.SONG_SYNC_CURSOR]: SYNCED_AT.toISOString(),
            [STORAGE_KEYS.SONG_SYNC_KEY]: JSON.stringify({ version: SYNCED_AT.toISOString(), songId: "a3" }),
            [STORAGE_KEYS.SONG_RECONCILE_AT]: String(SYNCED_AT.getTime()),
            [STORAGE_KEYS.SONG_RECONCILE_STATE]: JSON.stringify({ host: HOST, userId: A, misses: [] }),
            [STORAGE_KEYS.SONG_FIELDS_REVISION]: "1",
            [STORAGE_KEYS.DOWNLOADS_PAUSED]: "1",
        });

        expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);

        expect(playbackStops).toBe(1);
        expect(deleted.map(s => s.fileHash)).toEqual(["shared"]);
        for (const table of [songTable, artistTable, songArtistTable, tagTable, songTagTable, downloadedSongTable,
            downloadQueueTable, recentlyPlayedSongTable]) {
            expect(await count(db, table)).toBe(0);
        }
        // The device-wide song-sync keys reset, so B's first sync is a clean one; the user's own settings stay.
        for (const key of SONG_CACHE_STORAGE_KEYS) {
            expect(map.has(key)).toBe(false);
        }
        expect(map.get(STORAGE_KEYS.DOWNLOADS_PAUSED)).toBe("1");
        expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(B);
        expect(map.get(STORAGE_KEYS.SONG_CACHE_HOST)).toBe(HOST);

        // B's first sync.
        await updateSongs(db, [song("b1"), song("b2")]);
        expect((await getAllSongDetails(db)).map(x => x.song.songId).sort()).toEqual(["b1", "b2"]);
        for (let i = 0; i < 10; i++) {
            expect(["b1", "b2"]).toContain(await getRandomSongId(db));
        }
    });

    it("logging back in as the same account clears nothing", async () => {
        const { map, storage } = makeStorage({
            [STORAGE_KEYS.SONG_CACHE_USER_ID]: A,
            [STORAGE_KEYS.SONG_SYNC_CURSOR]: SYNCED_AT.toISOString(),
        });
        let syncStops = 0;
        stopSync = async () => { syncStops++; };

        expect(await claimSongCache(deps(storage), A, HOST)).toBe(false);

        expect(syncStops).toBe(0);
        expect(playbackStops).toBe(0);
        expect(deleted).toEqual([]);
        expect(await count(db, songTable)).toBe(3);
        expect(await count(db, downloadedSongTable)).toBe(1);
        expect(await count(db, downloadQueueTable)).toBe(1);
        expect(map.get(STORAGE_KEYS.SONG_SYNC_CURSOR)).toBe(SYNCED_AT.toISOString());
        expect((await db.select().from(userTable))[0].version).toEqual(SYNCED_AT);
        expect((await db.select().from(playlistTable))[0].version).toEqual(SYNCED_AT);
    });

    it("A's queued outbox rows, dead letters, unsent listens and other per-user rows survive the switch", async () => {
        await seedUnsentDecisions(db, A, "a1");
        const before = {
            requests: await db.select().from(requestTable),
            deadLetters: await db.select().from(deadLetterRequestTable),
            listens: await db.select().from(listenTable),
            listenStats: await db.select().from(listenStatTable),
            playNext: await db.select().from(playNextIntentTable),
            userSongs: await db.select().from(userSongTable),
            playlistSongs: await db.select().from(playlistSongTable),
            sessions: await db.select().from(localSessionDataTable),
            genreJams: await db.select().from(genreJamTable),
        };
        const { storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A });

        expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);

        expect(await db.select().from(requestTable)).toEqual(before.requests);
        expect(await db.select().from(deadLetterRequestTable)).toEqual(before.deadLetters);
        expect(await db.select().from(listenTable)).toEqual(before.listens);
        expect(await db.select().from(listenStatTable)).toEqual(before.listenStats);
        expect(await db.select().from(playNextIntentTable)).toEqual(before.playNext);
        expect(await db.select().from(userSongTable)).toEqual(before.userSongs);
        expect(await db.select().from(playlistSongTable)).toEqual(before.playlistSongs);
        expect(await db.select().from(localSessionDataTable)).toEqual(before.sessions);
        expect(await db.select().from(genreJamTable)).toEqual(before.genreJams);
        // Still A's to send, in order, the next time A logs in; nothing of B's is mixed in.
        expect((await getRequests(db, A)).map(x => x.requestId)).toEqual(["like", "keep", "listen"]);
        expect(await getRequests(db, B)).toEqual([]);
    });

    it("resets every account's sync cursors, so A coming back pages its whole library again", async () => {
        const { storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A });
        await claimSongCache(deps(storage), B, HOST);

        // The user-songs feed starts from FEED_START, as on a first sync...
        const [userA] = await db.select().from(userTable);
        expect(userA.version).toEqual(new Date(FEED_START));
        // ...and A's unchanged playlist is fetched again, songs included.
        const localPlaylists = await db.select().from(playlistTable);
        expect(playlistsToFetch([{ playlistId: `playlist-${A}`, version: SYNCED_AT }], localPlaylists)).toEqual([`playlist-${A}`]);

        // And back to A: a different account from B, so B's songs go the same way.
        await updateSongs(db, [song("b1"), song("b2")]);
        await db.insert(downloadedSongTable).values({ downloadedSongId: "dl-b1", songId: "b1" });
        deleted = [];
        expect(await claimSongCache(deps(storage), A, HOST)).toBe(true);
        expect(deleted.map(s => s.songId)).toEqual(["b1"]);
        expect(await count(db, songTable)).toBe(0);
    });

    it("waits for A's sync still running before clearing, so nothing it writes survives", async () => {
        const { storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A });
        stopSync = async () => {
            // A's last sync commits while the switch waits for it: one more song, and A's version moves on.
            await updateSongs(db, [song("a4")]);
            await db.insert(downloadedSongTable).values({ downloadedSongId: "dl-a4", songId: "a4" });
            await db.update(userTable).set({ version: new Date("2026-11-02T00:00:00Z") });
        };

        expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);

        expect(await count(db, songTable)).toBe(0);
        expect(deleted.map(s => s.songId)).toContain("a4");
        expect((await db.select().from(userTable))[0].version).toEqual(new Date(FEED_START));
    });

    // The steps run files, then the transaction, then the storage keys, then the owner. A run that dies anywhere before
    // the owner leaves it as it was, and the next login finishes the job.
    it.each([
        ["deleting a file", "files"],
        ["resetting the song-sync keys", "keys"],
    ] as const)("a clear that fails while %s leaves the owner unchanged, and the next login clears again", async (_what, failAt) => {
        const { map, storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A, [STORAGE_KEYS.SONG_SYNC_CURSOR]: "c" });
        const failing = { ...deps(storage) };
        if (failAt === "files") {
            failing.deleteSongFiles = async () => { throw new Error("disk gone"); };
        } else {
            failing.storage = { ...storage, removeItem: async () => { throw new Error("storage gone"); } };
        }

        await expect(claimSongCache(failing, B, HOST)).rejects.toThrow();
        expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(A);
        expect(await count(db, songTable)).toBe(failAt === "files" ? 3 : 0);

        expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);
        expect(await count(db, songTable)).toBe(0);
        expect(map.has(STORAGE_KEYS.SONG_SYNC_CURSOR)).toBe(false);
        expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(B);
    });

    it("deletes the file of a download that lands while the clear waits for it", async () => {
        const { storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A });
        settleDownloads = async () => {
            // What the runner does with the queue emptied: the song in flight lands and records itself.
            await db.delete(downloadQueueTable);
            await db.insert(downloadedSongTable).values({ downloadedSongId: "dl-a3", songId: "a3" });
            return true;
        };

        expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);

        expect(deleted.map(s => s.fileHash).sort()).toEqual(["hash-a3", "shared"]);
        expect(await count(db, downloadedSongTable)).toBe(0);
    });

    it("still clears when downloads don't settle in time", async () => {
        const { map, storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A });
        settleDownloads = async () => false;

        expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);

        expect(await count(db, songTable)).toBe(0);
        expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(B);
    });

    describe("a device whose last build never recorded the cache's owner", () => {
        it("clears when another account has synced here", async () => {
            const { map, storage } = makeStorage();
            expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);
            expect(await count(db, songTable)).toBe(0);
            expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(B);
        });

        it("keeps everything when only this account has synced here", async () => {
            const { map, storage } = makeStorage();
            expect(await claimSongCache(deps(storage), A, HOST)).toBe(false);
            expect(await count(db, songTable)).toBe(3);
            expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(A);
        });

        // restoreSession adopts the cache for the signed-in account, so another account's leftover users row doesn't
        // make that same account's next login wipe its downloads.
        it("keeps everything on the restored account's next login, though another account has a users row", async () => {
            await db.insert(userTable).values({ userId: B, username: B, version: SYNCED_AT, isCurator: false });
            const { map, storage } = makeStorage();

            await adoptSongCache(db, storage, A, HOST);

            expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(A);
            expect(map.get(STORAGE_KEYS.SONG_CACHE_HOST)).toBe(HOST);
            expect(await claimSongCache(deps(storage), A, HOST)).toBe(false);
            expect(deleted).toEqual([]);
            expect(await count(db, songTable)).toBe(3);
        });

        it("adopting never replaces an owner already recorded", async () => {
            const { map, storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A, [STORAGE_KEYS.SONG_CACHE_HOST]: HOST });

            await adoptSongCache(db, storage, B, "https://other.example");

            expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(A);
            expect(map.get(STORAGE_KEYS.SONG_CACHE_HOST)).toBe(HOST);
        });
    });

    describe("genre jams (ShuffullApp#199)", () => {
        it("A then B: B sees none of A's jams, and A has them all back on its return", async () => {
            await addGenreJam(db, jam("a-jam", A));
            const { storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A });

            expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);
            expect(await jamIds(db, B)).toEqual([]);
            await addGenreJam(db, jam("b-jam", B));
            expect(await jamIds(db, B)).toEqual(["b-jam"]);

            expect(await claimSongCache(deps(storage), A, HOST)).toBe(true);
            expect(await jamIds(db, A)).toEqual(["a-jam"]);
            expect(await jamIds(db, B)).toEqual(["b-jam"]);
        });

        it("A logging back in keeps A's jams", async () => {
            await addGenreJam(db, jam("a-jam", A));
            const { storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A });

            expect(await claimSongCache(deps(storage), A, HOST)).toBe(false);

            expect(await jamIds(db, A)).toEqual(["a-jam"]);
        });

        // A jam from before this build has no account. Whoever the device's songs belong to made it, so it goes to them.
        it("upgrading with A signed in: the restored session gets A's existing jams", async () => {
            await addGenreJam(db, jam("old", null));
            const { storage } = makeStorage();

            await adoptSongCache(db, storage, A, HOST);

            expect(await jamIds(db, A)).toEqual(["old"]);
        });

        it("upgrading signed out: A logging in gets A's existing jams", async () => {
            await addGenreJam(db, jam("old", null));
            const { storage } = makeStorage();

            expect(await claimSongCache(deps(storage), A, HOST)).toBe(false);

            expect(await jamIds(db, A)).toEqual(["old"]);
        });

        it("an unowned jam on a device that holds A's songs stays A's when B logs in", async () => {
            // A jam a database rebuild carried over from the older schema, after A's songs were already recorded as A's.
            await addGenreJam(db, jam("old", null));
            const { storage } = makeStorage({ [STORAGE_KEYS.SONG_CACHE_USER_ID]: A });

            expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);

            expect(await jamIds(db, B)).toEqual([]);
            expect(await jamIds(db, A)).toEqual(["old"]);
        });

        it("with no owner ever recorded, the first account to log in gets the unowned jams, as before it saw them", async () => {
            await addGenreJam(db, jam("old", null));
            const { storage } = makeStorage();

            expect(await claimSongCache(deps(storage), B, HOST)).toBe(true);

            expect(await jamIds(db, B)).toEqual(["old"]);
        });
    });

    it("a fresh device clears nothing and records the first account", async () => {
        db = makeDb();
        const { map, storage } = makeStorage();
        expect(await claimSongCache(deps(storage), A, HOST)).toBe(false);
        expect(playbackStops).toBe(0);
        expect(map.get(STORAGE_KEYS.SONG_CACHE_USER_ID)).toBe(A);
    });
});
