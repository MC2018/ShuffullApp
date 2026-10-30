import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import type { RecordListenRequest } from "@/app/services/db/models";
import { getRequests } from "@/app/services/db/queries/request";
import { getOpenListens } from "@/app/services/db/queries/listen";
import { RequestType } from "@/app/enums";
import { ListenRecorder, ListenStart } from "@/app/services/listens/listenRecorder";

// The listen recorder (ShuffullApp#57) against the app's real schema: a listen opens at a track change, counts only
// playback, survives the app dying mid-song, and closes into the outbox exactly once.

const USER = "u1";
const T0 = Date.parse("2026-10-31T01:00:00.000Z");

function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

const start = (over: Partial<ListenStart> = {}): ListenStart => ({
    songId: "s1",
    userId: USER,
    context: "playlist",
    playlistId: "p1",
    platform: "android",
    ...over,
});

async function queuedListens(db: GenericDb): Promise<RecordListenRequest[]> {
    return (await getRequests(db, USER)).filter(x => x.requestType == RequestType.RecordListen) as RecordListenRequest[];
}

describe("ListenRecorder", () => {
    let db: GenericDb;
    let now: number;
    let duration: number | undefined;
    const makeRecorder = () => {
        const recorder = new ListenRecorder({ now: () => now, trackDuration: async () => duration, checkpointIntervalMs: 10_000 });
        recorder.attach(db);
        return recorder;
    };

    beforeEach(() => {
        // Only the checkpoint timer is faked: the serial lock's hold limit uses real timeouts.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        db = makeDb();
        now = T0;
        duration = 214;
    });
    afterEach(() => { vi.useRealTimers(); });

    it("a played and finished song queues one listen with its playback seconds", async () => {
        const recorder = makeRecorder();
        await recorder.begin(start());            // loaded, not yet playing
        now += 1_500;
        await recorder.playbackStateChanged(true);
        now += 30_000;
        await recorder.playbackStateChanged(false); // paused for a minute
        now += 60_000;
        await recorder.playbackStateChanged(true);
        now += 20_000;
        await recorder.end("finished");

        const [listen, ...rest] = await queuedListens(db);
        expect(rest).toEqual([]);
        expect(listen.requestId).toBe(listen.payload.listenId);
        expect(listen.songId).toBe("s1");
        expect(listen.payload).toMatchObject({
            songId: "s1",
            userId: USER,
            secondsListened: 50,
            songDurationSeconds: 214,
            endReason: "finished",
            context: "playlist",
            playlistId: "p1",
            platform: "android",
            startedAt: new Date(T0).toISOString(),
            endedAt: new Date(now).toISOString(),
        });
        expect(await getOpenListens(db)).toEqual([]);
        expect(recorder.openSongId).toBeUndefined();
    });

    it.each(["skipped", "previous", "stopped"] as const)("an end as %s is queued with that reason", async reason => {
        const recorder = makeRecorder();
        await recorder.begin(start({ playing: true }));
        now += 4_000;
        await recorder.end(reason);

        const [listen] = await queuedListens(db);
        expect(listen.payload.endReason).toBe(reason);
        expect(listen.payload.secondsListened).toBe(4);
    });

    it("beginning a new song closes the open one as stopped first", async () => {
        const recorder = makeRecorder();
        await recorder.begin(start({ songId: "a", playing: true }));
        now += 3_000;
        await recorder.begin(start({ songId: "b", playing: true }));

        const listens = await queuedListens(db);
        expect(listens.map(x => [x.songId, x.payload.endReason, x.payload.secondsListened])).toEqual([["a", "stopped", 3]]);
        expect(recorder.openSongId).toBe("b");
        expect((await getOpenListens(db)).map(x => x.songId)).toEqual(["b"]);
    });

    it("playback reported while the previous listen is still closing counts toward the new one", async () => {
        const recorder = makeRecorder();
        await recorder.begin(start({ songId: "a", playing: true }));
        now += 1_000;
        const beginning = recorder.begin(start({ songId: "b" }));
        const playing = recorder.playbackStateChanged(true); // the new track started before begin() settled
        await Promise.all([beginning, playing]);
        now += 6_000;
        await recorder.end("skipped");

        const listens = await queuedListens(db);
        expect(listens.map(x => [x.songId, x.payload.secondsListened])).toEqual([["a", 1], ["b", 6]]);
    });

    it("an end with nothing open, or a second end, queues nothing more", async () => {
        const recorder = makeRecorder();
        await recorder.end("skipped");
        await recorder.begin(start());
        await recorder.end("skipped");
        await recorder.end("skipped");

        expect(await queuedListens(db)).toHaveLength(1);
    });

    it("an unknown track duration is sent as null", async () => {
        duration = undefined;
        const recorder = makeRecorder();
        await recorder.begin(start());
        await recorder.end("skipped");

        expect((await queuedListens(db))[0].payload.songDurationSeconds).toBeNull();
    });

    it("without a db it does nothing and throws nothing", async () => {
        const recorder = new ListenRecorder({ now: () => now });
        await recorder.begin(start({ playing: true }));
        await recorder.playbackStateChanged(false);
        await recorder.end("finished");
        await recorder.recover();
    });

    describe("the app dying mid-song", () => {
        it("checkpoints on a timer while playing, and a new run recovers it as stopped at the last checkpoint", async () => {
            const dying = makeRecorder();
            await dying.begin(start({ playing: true }));
            now += 25_000;
            await vi.advanceTimersByTimeAsync(20_000); // two timer checkpoints, the last at 25 s of playback
            now += 7_000;                               // played 7 s more, then the app is killed: lost

            const [checkpoint] = await getOpenListens(db);
            expect(checkpoint.secondsListened).toBe(25);

            const nextRun = makeRecorder();
            await nextRun.recover();

            const [listen, ...rest] = await queuedListens(db);
            expect(rest).toEqual([]);
            expect(listen.payload).toMatchObject({
                listenId: checkpoint.listenId,
                endReason: "stopped",
                secondsListened: 25,
                songDurationSeconds: 214,
                startedAt: new Date(T0).toISOString(),
                endedAt: new Date(T0 + 25_000).toISOString(),
            });
            expect(await getOpenListens(db)).toEqual([]);
        });

        it("a pause checkpoints at once, so a kill while paused loses nothing", async () => {
            const dying = makeRecorder();
            await dying.begin(start({ playing: true }));
            now += 12_345;
            await dying.playbackStateChanged(false);
            now += 600_000;

            await makeRecorder().recover();

            const [listen] = await queuedListens(db);
            expect(listen.payload.secondsListened).toBe(12.345);
            expect(listen.payload.endedAt).toBe(new Date(T0 + 12_345).toISOString());
        });

        it("recover leaves the run's own open listen alone", async () => {
            const recorder = makeRecorder();
            await recorder.begin(start({ playing: true }));
            await recorder.recover();

            expect(await queuedListens(db)).toEqual([]);
            expect(await getOpenListens(db)).toHaveLength(1);
        });

        it("recovering twice queues the listen once", async () => {
            await makeRecorder().begin(start({ playing: true }));
            now += 5_000;

            await Promise.all([makeRecorder().recover(), makeRecorder().recover()]);

            expect(await queuedListens(db)).toHaveLength(1);
        });
    });

    it("a checkpoint queued behind a close can't reopen the listen", async () => {
        const recorder = makeRecorder();
        await recorder.begin(start({ playing: true }));
        now += 2_000;
        const checkpoint = recorder.checkpoint();
        const end = recorder.end("skipped");
        const late = recorder.checkpoint();
        await Promise.all([checkpoint, end, late]);

        expect(await getOpenListens(db)).toEqual([]);
        expect(await queuedListens(db)).toHaveLength(1);
    });
});
