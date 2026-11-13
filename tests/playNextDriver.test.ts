import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import type { ApiClient } from "@/app/services/api/ApiClient";
import type { SongRequest, SongRequestSearchResult } from "@/app/services/api/models";
import { songTable } from "@/app/services/db/schema";
import { getPlayNextIntents } from "@/app/services/db/queries/playNext";
import { SongRequestStatus } from "@/app/enums/SongRequestStatus";
import { PLAY_NEXT_WAIT_MS } from "@/app/tools/playNext";

// The play-next driver (ShuffullApp#108) end to end against the real schema: the tap's row, the reconcile after a
// sync, the queue it builds, the alert when a request ends badly, and the row going once its song plays. The media
// manager, the alert and React Native are stubbed; everything else is the real code.

const { queueNext, unqueue, playSpecificSong, showAlert } = vi.hoisted(() => ({
    queueNext: vi.fn((_songIds: string[]) => {}),
    playSpecificSong: vi.fn(async (_songId: string) => {}),
    unqueue: vi.fn((_songId: string) => {}),
    showAlert: vi.fn((_title: string, _message: string) => {}),
}));

vi.mock("@/app/tools", () => import("@/app/tools/pure"));
vi.mock("@/app/services/media-manager/mediaManager", async () => {
    const { create: createStore } = await import("zustand");
    return { queueNext, unqueue, playSpecificSong, useActiveSong: createStore<{ songId: string | null }>(() => ({ songId: "playing" })) };
});
vi.mock("@/app/tools/dialog", () => ({ showAlert }));
vi.mock("react-native", () => ({ AppState: { currentState: "active" } }));
vi.mock("expo-router", () => ({ useFocusEffect: () => {} }));
vi.mock("@/app/services/api/ApiProvider", () => ({ useApi: () => null }));

const { useActiveSong: activeSong } = await import("@/app/services/media-manager/mediaManager");
const { attachPlayNextRequest, cancelPlayNext, cancelPlayNextForSong, libraryPlayNextKey, playLibrarySongNext, playNowOrNext, reconcilePlayNext, recordPlayNext, savePlayNext, startPlayNext, usePlayNext } =
    await import("@/app/services/song-requests/playNext");
const { applySongRequest, currentSongRequests, refreshSongRequests } = await import("@/app/services/song-requests/useSongRequests");

const USER = "u1";

function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

function result(change: Partial<SongRequestSearchResult> = {}): SongRequestSearchResult {
    return {
        externalSongId: "yt-1", title: "A song", artists: ["An artist"], album: null, durationSeconds: 200,
        thumbnailUrl: null, isExplicit: false, inLibrary: false, alreadyRequested: false, songId: null, inUserLibrary: false, ...change,
    } as SongRequestSearchResult;
}

function request(status: SongRequestStatus, change: Partial<SongRequest> = {}): SongRequest {
    const now = new Date();
    return {
        songRequestId: "r1", externalSongId: "yt-1", title: "A song", artists: ["An artist"], durationSeconds: 200,
        thumbnailUrl: null, status, failureReason: null, songId: status === SongRequestStatus.Completed ? "s1" : null,
        targetPlaylistName: "Requests", createdAt: now, updatedAt: now, ...change,
    };
}

async function addSong(db: GenericDb, songId: string) {
    await db.insert(songTable).values({
        songId, fileExtension: ".mp3", fileHash: `hash-${songId}`, name: `Song ${songId}`,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, heaviness: null, exploratory: true, tagsStale: false, hookStartPercent: null,
    });
}

let db: GenericDb;
let api: ApiClient;
let serverList: SongRequest[];
let stop: () => void;

beforeEach(async () => {
    vi.clearAllMocks();
    activeSong.setState({ songId: "playing" });
    db = makeDb();
    serverList = [];
    api = { songRequestListMine: vi.fn(async () => serverList) } as unknown as ApiClient;
    stop = startPlayNext(db, api, USER);
    await reconcilePlayNext({ readRequests: false });
});

afterEach(() => {
    stop();
    vi.useRealTimers();
});

/** The tap, as the search screen does it: save the intent, file the request, attach it. */
async function tap(filed: SongRequest) {
    await recordPlayNext(result());
    applySongRequest(api, filed);
    await attachPlayNextRequest(filed);
}

describe("play-next driver", () => {
    it("saves the intent at the tap, waits while the request is open, and queues the song once it is local", async () => {
        await tap(request(SongRequestStatus.Pending));
        expect(await getPlayNextIntents(db, USER)).toMatchObject([{ externalSongId: "yt-1", songRequestId: "r1", songId: null }]);
        expect(queueNext).not.toHaveBeenCalledWith(expect.arrayContaining(["s1"]));

        // The producer finishes; the next sync reads the list but hasn't brought the song down yet.
        serverList = [request(SongRequestStatus.Completed)];
        await reconcilePlayNext({ readRequests: true });
        expect(await getPlayNextIntents(db, USER)).toMatchObject([{ songId: "s1" }]);
        expect(queueNext).not.toHaveBeenCalledWith(["s1"]);

        // The sync after that has it.
        await addSong(db, "s1");
        await reconcilePlayNext({ readRequests: true });
        expect(queueNext).toHaveBeenLastCalledWith(["s1"]);
        expect(usePlayNext.getState().queuedSongIds).toEqual(["s1"]);
        expect(showAlert).not.toHaveBeenCalled();
    });

    it("drops the row once its song starts playing, and takes it off the queue", async () => {
        await addSong(db, "s1");
        await tap(request(SongRequestStatus.Completed));
        expect(queueNext).toHaveBeenLastCalledWith(["s1"]);

        activeSong.setState({ songId: "s1" });
        await vi.waitFor(async () => expect(await getPlayNextIntents(db, USER)).toEqual([]));
        expect(unqueue).toHaveBeenCalledWith("s1");
        expect(usePlayNext.getState().intents).toEqual([]);
    });

    it("drops a failed request with one alert, however many syncs see it", async () => {
        await tap(request(SongRequestStatus.Downloading));
        serverList = [request(SongRequestStatus.Failed, { failureReason: "Video unavailable" })];
        await reconcilePlayNext({ readRequests: true });
        await reconcilePlayNext({ readRequests: true });

        expect(await getPlayNextIntents(db, USER)).toEqual([]);
        expect(showAlert).toHaveBeenCalledTimes(1);
        expect(showAlert).toHaveBeenCalledWith("Not playing next", expect.stringContaining("Video unavailable"));
    });

    it("survives a restart: a new session reads the row back and queues the song once it arrives", async () => {
        await tap(request(SongRequestStatus.Pending));
        stop();

        stop = startPlayNext(db, api, USER);
        await reconcilePlayNext({ readRequests: false });
        expect(usePlayNext.getState().intents).toMatchObject([{ externalSongId: "yt-1", songRequestId: "r1" }]);

        serverList = [request(SongRequestStatus.Completed)];
        await addSong(db, "s1");
        await reconcilePlayNext({ readRequests: true });
        expect(queueNext).toHaveBeenLastCalledWith(["s1"]);
    });

    it("gives up after the wait, with a message", async () => {
        await tap(request(SongRequestStatus.Retrying));
        serverList = [request(SongRequestStatus.Retrying)];
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + PLAY_NEXT_WAIT_MS + 1_000 });
        await reconcilePlayNext({ readRequests: true });
        expect(await getPlayNextIntents(db, USER)).toEqual([]);
        expect(showAlert).toHaveBeenCalledWith("Not playing next", expect.stringContaining("took too long"));
    });

    it("cancel drops the row and unqueues its song", async () => {
        await addSong(db, "s1");
        await tap(request(SongRequestStatus.Completed));
        await cancelPlayNext("yt-1");
        expect(await getPlayNextIntents(db, USER)).toEqual([]);
        expect(unqueue).toHaveBeenCalledWith("s1");
        expect(showAlert).not.toHaveBeenCalled();
    });

    // Shuffull#117: the search screen saves a song the user has with its id and files nothing.
    it("a song the user has needs no request: never reads the list, and queues once a sync brings it down", async () => {
        await recordPlayNext(result({ inLibrary: true, songId: "s1", inUserLibrary: true }), { songId: "s1", songRequestId: null });
        await reconcilePlayNext({ readRequests: true });
        expect(await getPlayNextIntents(db, USER)).toMatchObject([{ externalSongId: "yt-1", songRequestId: null, songId: "s1" }]);
        expect(api.songRequestListMine).not.toHaveBeenCalled();
        expect(queueNext).not.toHaveBeenCalledWith(["s1"]);

        await addSong(db, "s1");
        await reconcilePlayNext({ readRequests: true });
        expect(queueNext).toHaveBeenLastCalledWith(["s1"]);
        expect(api.songRequestListMine).not.toHaveBeenCalled();
        expect(showAlert).not.toHaveBeenCalled();
    });

    // Shuffull#117: play now on a song the server has linked to the user.
    it("play now on a song this device has plays it and saves no intent", async () => {
        await addSong(db, "s1");
        const played = await playNowOrNext(db, result(), { songId: "s1", songRequestId: null }, new AbortController().signal);
        expect(played).toEqual({ outcome: "played", queued: false });
        expect(playSpecificSong).toHaveBeenCalledWith("s1");
        expect(await getPlayNextIntents(db, USER)).toEqual([]);
    });

    it("play now on a song not on this device saves the intent before it waits, so leaving still plays it next", async () => {
        const controller = new AbortController();
        const playing = playNowOrNext(db, result(), { songId: "s1", songRequestId: "r1" }, controller.signal);
        await vi.waitFor(async () =>
            expect(await getPlayNextIntents(db, USER)).toMatchObject([{ externalSongId: "yt-1", songRequestId: "r1", songId: "s1" }]));

        controller.abort(); // the user leaves the screen
        expect(await playing).toEqual({ outcome: "cancelled", queued: true });
        expect(playSpecificSong).not.toHaveBeenCalled();

        await addSong(db, "s1");
        await reconcilePlayNext({ readRequests: true });
        expect(queueNext).toHaveBeenLastCalledWith(["s1"]);
    });

    // ShuffullApp#25: "Play next" on the song page, for a song already in the library.
    it("play next on a library song queues it at once, keyed by its song id, and needs no request", async () => {
        await addSong(db, "s1");
        expect(await playLibrarySongNext({ songId: "s1", name: "Song s1" })).toBeNull();

        expect(await getPlayNextIntents(db, USER)).toMatchObject([
            { externalSongId: libraryPlayNextKey("s1"), songId: "s1", songRequestId: null, title: "Song s1" },
        ]);
        expect(queueNext).toHaveBeenLastCalledWith(["s1"]);
        expect(api.songRequestListMine).not.toHaveBeenCalled();
        expect(showAlert).not.toHaveBeenCalled();
    });

    it("play next on the song playing now saves nothing and says why", async () => {
        await addSong(db, "playing");
        expect(await playLibrarySongNext({ songId: "playing", name: "Song playing" })).toBe("It's playing now.");
        expect(await getPlayNextIntents(db, USER)).toEqual([]);
    });

    it("library play-nexts play in the order they were asked for", async () => {
        await addSong(db, "s1");
        await addSong(db, "s2");
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        await playLibrarySongNext({ songId: "s1", name: "Song s1" });
        vi.setSystemTime(Date.now() + 1); // created_at is in milliseconds
        await playLibrarySongNext({ songId: "s2", name: "Song s2" });
        expect(queueNext).toHaveBeenLastCalledWith(["s1", "s2"]);
    });

    it("asking for a song from both screens keeps one row, whichever asked first", async () => {
        await addSong(db, "s1");
        const owned = result({ songId: "s1", inLibrary: true, inUserLibrary: true });

        await playLibrarySongNext({ songId: "s1", name: "Song s1" });
        expect(await savePlayNext(owned, { songId: "s1", songRequestId: null })).toBeNull();
        expect(await getPlayNextIntents(db, USER)).toMatchObject([{ externalSongId: libraryPlayNextKey("s1") }]);

        await cancelPlayNextForSong("s1");
        await savePlayNext(owned, { songId: "s1", songRequestId: null });
        await playLibrarySongNext({ songId: "s1", name: "Song s1" });
        expect(await getPlayNextIntents(db, USER)).toMatchObject([{ externalSongId: "yt-1" }]);
        expect(usePlayNext.getState().intents).toHaveLength(1);
    });

    it("taking a song off play next drops every row that names it, from either screen, and unqueues it", async () => {
        await addSong(db, "s1");
        // A request row learns its song only once the request completes, so it can't be matched at the tap.
        await recordPlayNext(result());
        await playLibrarySongNext({ songId: "s1", name: "Song s1" });
        await attachPlayNextRequest(request(SongRequestStatus.Completed));
        expect(await getPlayNextIntents(db, USER)).toHaveLength(2);

        await cancelPlayNextForSong("s1");
        expect(await getPlayNextIntents(db, USER)).toEqual([]);
        expect(usePlayNext.getState().intents).toEqual([]);
        expect(unqueue).toHaveBeenCalledWith("s1");
    });

    it("puts play-next songs back when a new song starts, since a new scope empties the queue", async () => {
        await addSong(db, "s1");
        await playLibrarySongNext({ songId: "s1", name: "Song s1" });
        queueNext.mockClear();

        // The user taps another song in a playlist: the media manager cleared its queue and started that song.
        activeSong.setState({ songId: "picked" });
        await vi.waitFor(() => expect(queueNext).toHaveBeenCalledWith(["s1"]));
        expect(await getPlayNextIntents(db, USER)).toHaveLength(1);
    });

    it("when one play-next song starts, the others are put back and it is not", async () => {
        await addSong(db, "s1");
        await addSong(db, "s2");
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        await playLibrarySongNext({ songId: "s1", name: "Song s1" });
        vi.setSystemTime(Date.now() + 1);
        await playLibrarySongNext({ songId: "s2", name: "Song s2" });
        queueNext.mockClear();

        activeSong.setState({ songId: "s1" });
        await vi.waitFor(() => expect(queueNext).toHaveBeenCalledWith(["s2"]));
        expect(await getPlayNextIntents(db, USER)).toMatchObject([{ songId: "s2" }]);
        expect(queueNext).not.toHaveBeenCalledWith(expect.arrayContaining(["s1"]));
    });

    it("queues nothing for a session that has stopped", async () => {
        await addSong(db, "s1");
        await recordPlayNext(result());
        stop();
        queueNext.mockClear();
        await attachPlayNextRequest(request(SongRequestStatus.Completed));
        expect(queueNext).not.toHaveBeenCalled();
        expect(usePlayNext.getState().intents).toEqual([]);
    });
});

describe("the shared request list", () => {
    it("a read for a session that has since been replaced is thrown away", async () => {
        let answer!: (list: SongRequest[]) => void;
        const slow = { songRequestListMine: vi.fn(() => new Promise<SongRequest[]>(resolve => { answer = resolve; })) } as unknown as ApiClient;
        const read = refreshSongRequests(slow);
        applySongRequest(api, request(SongRequestStatus.Pending));
        answer([request(SongRequestStatus.Completed, { songRequestId: "other" })]);
        await read;
        expect(currentSongRequests(slow)).toBeNull();
        expect(currentSongRequests(api)?.map(r => r.songRequestId)).toEqual(["r1"]);
    });
});
