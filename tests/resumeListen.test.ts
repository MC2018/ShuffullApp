import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { readFileSync } from "node:fs";
import type { GenericDb } from "@/app/services/db/GenericDb";
import type { RecordListenRequest } from "@/app/services/db/models";
import { getRequests } from "@/app/services/db/queries/request";
import { getOpenListens } from "@/app/services/db/queries/listen";
import { RequestType } from "@/app/enums";
import { ListenRecorder } from "@/app/services/listens/listenRecorder";
import { openListenIfPlaying, ResumeListenInput } from "@/app/services/listens/resumeListen";

// A JS restart while the native player keeps playing (ShuffullApp#143): setup() recovers the old run's listen as
// stopped at its last checkpoint, then opens a new one for the rest of the play, if the song is still playing.

const USER = "u1";
const T0 = Date.parse("2026-10-31T01:00:00.000Z");

function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

async function queuedListens(db: GenericDb): Promise<RecordListenRequest[]> {
    return (await getRequests(db, USER)).filter(x => x.requestType == RequestType.RecordListen) as RecordListenRequest[];
}

describe("a listen for a song still playing when the JS context restarts", () => {
    let db: GenericDb;
    let now: number;
    const makeRecorder = () => {
        const recorder = new ListenRecorder({ now: () => now, trackDuration: async () => 214, checkpointIntervalMs: 10_000 });
        recorder.attach(db);
        return recorder;
    };
    const opener = (recorder: ListenRecorder, over: Partial<ResumeListenInput> = {}): ResumeListenInput => ({
        activeSongId: "s1",
        openSongId: recorder.openSongId,
        auditionOpen: false,
        isPlaying: async () => true,
        loadedTrackId: async () => "s1",
        begin: songId => recorder.begin({ songId, userId: USER, context: "playlist", playlistId: "p1", platform: "android", playing: true }),
        ...over,
    });

    // The old run plays s1 for 25 s (checkpointed by the timer), 7 s more go unsaved, then its JS context dies.
    async function oldRunDiesMidSong() {
        const dying = makeRecorder();
        await dying.begin({ songId: "s1", userId: USER, context: "playlist", playlistId: "p1", platform: "android", playing: true });
        now += 25_000;
        await vi.advanceTimersByTimeAsync(20_000);
        now += 7_000;
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        db = makeDb();
        now = T0;
    });
    afterEach(() => { vi.useRealTimers(); });

    it("reloaded while playing: one recovered stopped listen, and one new open listen from now on", async () => {
        await oldRunDiesMidSong();

        // setup(): recover() is fired without waiting, then the listen is opened once the player answers.
        const nextRun = makeRecorder();
        const recovering = nextRun.recover();
        expect(await openListenIfPlaying(opener(nextRun))).toBe(true);
        await recovering;

        const [recovered, ...rest] = await queuedListens(db);
        expect(rest).toEqual([]);
        expect(recovered.payload).toMatchObject({ songId: "s1", endReason: "stopped", secondsListened: 25 });
        const [open, ...moreOpen] = await getOpenListens(db);
        expect(moreOpen).toEqual([]);
        expect(open.songId).toBe("s1");
        expect(open.listenId).not.toBe(recovered.payload.listenId);
        expect(nextRun.openSongId).toBe("s1");

        // The rest of the play, counted once: the new listen starts where the recovered one can't reach.
        now += 40_000;
        await nextRun.end("finished");
        const listens = await queuedListens(db);
        expect(listens.map(x => x.payload.listenId)).toEqual([recovered.payload.listenId, open.listenId]);
        const second = listens[1];
        expect(second.payload).toMatchObject({ endReason: "finished", secondsListened: 40, startedAt: new Date(T0 + 32_000).toISOString() });
        expect(Date.parse(second.payload.startedAt)).toBeGreaterThanOrEqual(Date.parse(recovered.payload.endedAt));
        expect(listens.reduce((sum, x) => sum + x.payload.secondsListened, 0)).toBe(65);
        expect(await getOpenListens(db)).toEqual([]);
    });

    it("reloaded while paused: the old listen is recovered and nothing new opens", async () => {
        await oldRunDiesMidSong();

        const nextRun = makeRecorder();
        const recovering = nextRun.recover();
        expect(await openListenIfPlaying(opener(nextRun, { isPlaying: async () => false }))).toBe(false);
        await recovering;

        expect((await queuedListens(db)).map(x => x.payload.endReason)).toEqual(["stopped"]);
        expect(await getOpenListens(db)).toEqual([]);
        expect(nextRun.openSongId).toBeUndefined();
    });

    it("opens nothing when the player is playing another song than the one the app shows", async () => {
        // An audition deck song writes no play history, so after a restart the app's current song can be another.
        const recorder = makeRecorder();
        const loadedTrackId = vi.fn(async () => "deck-song");
        expect(await openListenIfPlaying(opener(recorder, { loadedTrackId }))).toBe(false);
        expect(loadedTrackId).toHaveBeenCalled();
        expect(await getOpenListens(db)).toEqual([]);
    });

    it.each([
        ["no current song", { activeSongId: undefined }],
        ["a listen already open", { openSongId: "s1" }],
        ["audition mode open", { auditionOpen: true }],
    ] as const)("opens nothing with %s, without asking the player", async (_, over) => {
        const recorder = makeRecorder();
        const isPlaying = vi.fn(async () => true);
        expect(await openListenIfPlaying(opener(recorder, { ...over, isPlaying }))).toBe(false);
        expect(isPlaying).not.toHaveBeenCalled();
        expect(await getOpenListens(db)).toEqual([]);
    });
});

// mediaManager imports native modules and can't load here, so its call sites are checked as text.
describe("the media manager", () => {
    const source = readFileSync(path.resolve(__dirname, "../app/services/media-manager/mediaManager.ts"), "utf8");
    const setupBody = source.slice(source.indexOf("export async function setup("), source.indexOf("\n}\n", source.indexOf("export async function setup(")));

    it("opens a listen at the end of setup(), after recover(), under the transport lock", () => {
        expect(setupBody).toContain("void listenRecorder.recover();");
        expect(setupBody).toContain("playerReady.then(() => transportLock.run(openListenForResume))");
        expect(setupBody.indexOf("listenRecorder.recover()")).toBeLessThan(setupBody.indexOf("openListenForResume"));
        expect(setupBody.indexOf("setSongId(currentlyPlayingSong.songId)")).toBeLessThan(setupBody.indexOf("openListenForResume"));
    });

    it("adds this context's player listeners when an earlier context set the player up, and only once", () => {
        const init = source.slice(source.indexOf("async function initTrackPlayer()"), source.indexOf("async function setupEventListeners()"));
        expect(init).toMatch(/if \(setUpBefore\) \{[\s\S]*await setupEventListeners\(\);/);
        const listeners = source.slice(source.indexOf("async function setupEventListeners()"));
        expect(listeners.slice(0, listeners.indexOf("TrackPlayer.addEventListener("))).toMatch(
            /if \(eventListenersAdded\) \{\s*return;\s*\}\s*eventListenersAdded = true;/,
        );
    });

    it("decides with openListenIfPlaying", () => {
        const body = source.slice(source.indexOf("async function openListenForResume()"));
        expect(body.slice(0, body.indexOf("\n}\n"))).toContain("await openListenIfPlaying({");
    });
});
