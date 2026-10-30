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
import { openListenIfPlaying, recoverListensAfterRestart, RestartListenInput, ResumeListenInput } from "@/app/services/listens/resumeListen";

// A JS restart while the native player keeps playing (ShuffullApp#143, ShuffullApp#147): once setup() has the player,
// it closes the old run's listen at its last checkpoint, unless that listen is still the song playing, which the new
// run carries on. Otherwise it opens a new listen for the rest of the play, if a song is still playing.

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
    // setup()'s call, once the player is ready. The player is 32 s into s1 unless a test says otherwise.
    const restart = (recorder: ListenRecorder, over: Partial<RestartListenInput> = {}) => recoverListensAfterRestart({
        ...opener(recorder),
        positionSeconds: async () => 32,
        recover: playing => recorder.recover(playing),
        ...over,
    });

    // The old run plays s1 for 25 s (checkpointed by the timer), 7 s more go unsaved, then its JS context dies.
    async function oldRunDiesMidSong(): Promise<string> {
        const dying = makeRecorder();
        await dying.begin({ songId: "s1", userId: USER, context: "playlist", playlistId: "p1", platform: "android", playing: true });
        now += 25_000;
        await vi.advanceTimersByTimeAsync(20_000);
        now += 7_000;
        vi.clearAllTimers(); // its checkpoint timer died with it
        const [orphan] = await getOpenListens(db);
        return orphan.listenId;
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        db = makeDb();
        now = T0;
    });
    afterEach(() => { vi.useRealTimers(); });

    it("reloaded mid-song, then skipped 15 s later: one listen of 40 s, not a quick skip", async () => {
        const orphanId = await oldRunDiesMidSong();

        const nextRun = makeRecorder();
        expect(await restart(nextRun)).toBe("tookOver");
        expect(await queuedListens(db)).toEqual([]);
        expect(nextRun.openSongId).toBe("s1");

        now += 15_000;
        await nextRun.end("skipped");

        const [listen, ...rest] = await queuedListens(db);
        expect(rest).toEqual([]);
        expect(listen.payload).toMatchObject({
            listenId: orphanId,
            songId: "s1",
            endReason: "skipped",
            secondsListened: 40, // the 25 checkpointed, then 15: the 7 s between checkpoint and restart nobody saw
            songDurationSeconds: 214,
            startedAt: new Date(T0).toISOString(),
            endedAt: new Date(T0 + 47_000).toISOString(),
        });
        // Over the server's maybe-drop threshold (MaybeDropRule.Default, 30 s), so it's no quick skip.
        expect(listen.payload.secondsListened).toBeGreaterThanOrEqual(30);
        expect(await getOpenListens(db)).toEqual([]);
    });

    it("a listen carried on keeps checkpointing under its id, so a second restart carries it on again", async () => {
        const orphanId = await oldRunDiesMidSong();
        const second = makeRecorder();
        expect(await restart(second)).toBe("tookOver");
        now += 10_000;
        await vi.advanceTimersByTimeAsync(10_000);

        const [checkpoint] = await getOpenListens(db);
        expect([checkpoint.listenId, checkpoint.secondsListened]).toEqual([orphanId, 35]);

        now += 3_000; // dies again
        vi.clearAllTimers();
        const third = makeRecorder();
        expect(await restart(third, { positionSeconds: async () => 45 })).toBe("tookOver");
        now += 20_000;
        await third.end("finished");

        const listens = await queuedListens(db);
        expect(listens.map(x => [x.payload.listenId, x.payload.endReason, x.payload.secondsListened])).toEqual([[orphanId, "finished", 55]]);
    });

    it("a different song loaded closes the old listen as stopped and opens a new one, as before", async () => {
        const orphanId = await oldRunDiesMidSong();

        const nextRun = makeRecorder();
        expect(await restart(nextRun, { activeSongId: "s2", loadedTrackId: async () => "s2" })).toBe("opened");

        const [recovered, ...rest] = await queuedListens(db);
        expect(rest).toEqual([]);
        expect(recovered.payload).toMatchObject({ listenId: orphanId, songId: "s1", endReason: "stopped", secondsListened: 25 });
        const [open, ...moreOpen] = await getOpenListens(db);
        expect(moreOpen).toEqual([]);
        expect([open.songId, open.secondsListened]).toEqual(["s2", 0]);
        expect(open.listenId).not.toBe(orphanId);
    });

    it("the same song near its start may have started over: the old listen closes and a new one opens from now", async () => {
        // 7 s since the checkpoint and the player only 7 s in: this could be a new play (repeat), so it isn't merged.
        const orphanId = await oldRunDiesMidSong();

        const nextRun = makeRecorder();
        expect(await restart(nextRun, { positionSeconds: async () => 7 })).toBe("opened");
        now += 40_000;
        await nextRun.end("finished");

        const listens = await queuedListens(db);
        expect(listens.map(x => [x.payload.listenId === orphanId, x.payload.endReason, x.payload.secondsListened])).toEqual([
            [true, "stopped", 25],
            [false, "finished", 40],
        ]);
        // The new listen starts where the recovered one can't reach, so no second counts twice.
        expect(Date.parse(listens[1].payload.startedAt)).toBeGreaterThanOrEqual(Date.parse(listens[0].payload.endedAt));
    });

    it("the player's position unknown: nothing is carried on", async () => {
        await oldRunDiesMidSong();
        const nextRun = makeRecorder();
        expect(await restart(nextRun, { positionSeconds: async () => { throw new Error("no player"); } })).toBe("opened");
        expect((await queuedListens(db)).map(x => x.payload.endReason)).toEqual(["stopped"]);
    });

    it("reloaded while paused: the old listen is recovered and nothing new opens", async () => {
        await oldRunDiesMidSong();

        const nextRun = makeRecorder();
        expect(await restart(nextRun, { isPlaying: async () => false })).toBe("none");

        expect((await queuedListens(db)).map(x => x.payload.endReason)).toEqual(["stopped"]);
        expect(await getOpenListens(db)).toEqual([]);
        expect(nextRun.openSongId).toBeUndefined();
    });

    it("the player failing to answer still closes the old listen", async () => {
        await oldRunDiesMidSong();

        const nextRun = makeRecorder();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(await restart(nextRun, { isPlaying: async () => { throw new Error("not set up"); } })).toBe("none");
        warn.mockRestore();

        expect((await queuedListens(db)).map(x => x.payload.endReason)).toEqual(["stopped"]);
        expect(await getOpenListens(db)).toEqual([]);
    });

    it("a listen this run already opened (a skip before the player was ready) means nothing is carried on", async () => {
        const orphanId = await oldRunDiesMidSong();

        const nextRun = makeRecorder();
        await nextRun.begin({ songId: "s1", userId: USER, context: "playlist", playlistId: "p1", platform: "android", playing: true });
        expect(await restart(nextRun)).toBe("none");

        expect((await queuedListens(db)).map(x => [x.payload.listenId, x.payload.endReason])).toEqual([[orphanId, "stopped"]]);
        const [open, ...moreOpen] = await getOpenListens(db);
        expect(moreOpen).toEqual([]);
        expect([open.songId, open.secondsListened, open.listenId === orphanId]).toEqual(["s1", 0, false]);
    });

    it("the transition to Playing opens a listen for the current song when none is open", async () => {
        const recorder = makeRecorder();
        expect(await openListenIfPlaying(opener(recorder))).toBe(true);
        expect((await getOpenListens(db)).map(x => x.songId)).toEqual(["s1"]);
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

    it("recovers the last run's listens at the end of setup(), once the player is ready, under the transport lock", () => {
        expect(setupBody).not.toContain("listenRecorder.recover(");
        expect(setupBody).toMatch(/void playerReady\s*\.catch\([^\n]*\)\s*\.then\(\(\) => transportLock\.run\(recoverListensForRestart\)\);/);
        expect(setupBody.indexOf("setSongId(currentlyPlayingSong.songId)")).toBeLessThan(setupBody.indexOf("recoverListensForRestart"));
    });

    it("opens no listen on a transition to Playing until the recovery has run", () => {
        const body = source.slice(source.indexOf("async function openListenForResume()"));
        expect(body.slice(0, body.indexOf("\n}\n"))).toContain("if (activeDb == undefined || !listensRecovered) {");
        const recovery = source.slice(source.indexOf("async function recoverListensForRestart()"));
        expect(recovery.slice(0, recovery.indexOf("\n}\n"))).toMatch(/await recoverListensAfterRestart\([\s\S]*\} finally \{\s*listensRecovered = true;/);
    });

    it("adds this JS context's player listeners whether or not the playback service task runs in it, and only once", () => {
        // After a JS reload the player module is a new instance, so getActiveTrack() throws even though the service
        // still runs: the listeners must be added after the try/catch, not in either branch.
        const init = source.slice(source.indexOf("async function initTrackPlayer()"), source.indexOf("async function setupEventListeners()"));
        expect(init.slice(init.lastIndexOf("    }\n"))).toContain("await setupEventListeners();");
        const listeners = source.slice(source.indexOf("async function setupEventListeners()"));
        expect(listeners.slice(0, listeners.indexOf("TrackPlayer.addEventListener("))).toMatch(
            /if \(eventListenersAdded\) \{\s*return;\s*\}\s*eventListenersAdded = true;/,
        );
    });

    it("decides with openListenIfPlaying", () => {
        const body = source.slice(source.indexOf("async function openListenForResume()"));
        expect(body.slice(0, body.indexOf("\n}\n"))).toContain("await openListenIfPlaying(resumeListenInput(activeDb));");
    });
});
