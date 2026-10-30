import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { recordKeep, recordLikeStatus, recordPlayed } from "@/app/services/db/queries/decision";
import { getAuditionDeckSongIds, getPlaylistSongStates } from "@/app/services/db/queries/playlist";
import { getRequests } from "@/app/services/db/queries/request";
import { playlistSongTable, playlistTable, songTable, userSongTable, userTable } from "@/app/services/db/schema";
import { LikeStatus, RequestType } from "@/app/enums";
import { AuditionRowState, deriveAuditionRowState } from "@/app/tools/audition";
import { AuditionPort, AuditionSession, DEFAULT_START_FRACTION, heardThresholdSeconds } from "@/app/tools/auditionSession";

// Audition mode's deck (ShuffullApp#125). The deck runs against a fake player here, and in the last block against
// the real query layer, to prove the property everything else rests on: flicking past a song never makes it look
// heard - and so never makes it purgeable with its mix.

type Call =
    | { kind: "load"; songId: string; startFraction: number }
    | { kind: "rate"; songId: string; likeStatus: LikeStatus }
    | { kind: "keep"; songId: string }
    | { kind: "markHeard"; songId: string }
    | { kind: "resume" | "pause" }
    | { kind: "seekTo"; seconds: number };

class FakePort implements AuditionPort {
    calls: Call[] = [];
    async load(songId: string, startFraction: number) { this.calls.push({ kind: "load", songId, startFraction }); }
    async resume() { this.calls.push({ kind: "resume" }); }
    async pause() { this.calls.push({ kind: "pause" }); }
    async seekTo(seconds: number) { this.calls.push({ kind: "seekTo", seconds }); }
    async rate(songId: string, likeStatus: LikeStatus) { this.calls.push({ kind: "rate", songId, likeStatus }); }
    async keep(songId: string) { this.calls.push({ kind: "keep", songId }); }
    async markHeard(songId: string) { this.calls.push({ kind: "markHeard", songId }); }
    prefetch() { }

    of(kind: Call["kind"]) {
        return this.calls.filter(c => c.kind === kind);
    }
    loads() {
        return (this.of("load") as Extract<Call, { kind: "load" }>[]).map(c => c.songId);
    }
    heard() {
        return (this.of("markHeard") as Extract<Call, { kind: "markHeard" }>[]).map(c => c.songId);
    }
}

// A stamp is written after the tick that decided it, in the deck's write queue.
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(songIds: string[]) {
    let ms = 0;
    const port = new FakePort();
    const session = new AuditionSession(songIds, port, () => ms);
    return {
        port,
        session,
        /** Lets `seconds` pass, with the player in whatever state it is in. */
        advance(seconds: number) {
            ms += seconds * 1000;
        },
        /** `seconds` of the current song playing, then the 1 s tick that would follow, and its write. */
        async play(seconds: number, duration = 200) {
            session.onPlaybackState(true);
            ms += seconds * 1000;
            session.tick(duration, true);
            await flush();
        },
    };
}

describe("the heard rule", () => {
    it("is 20 s, or half a song shorter than 40 s", () => {
        expect(heardThresholdSeconds(200)).toBe(20);
        expect(heardThresholdSeconds(40)).toBe(20);
        expect(heardThresholdSeconds(30)).toBe(15);
        expect(heardThresholdSeconds(undefined)).toBe(20);
        expect(heardThresholdSeconds(0)).toBe(20);
    });

    it("stamps a song once it has played 20 s, and not a moment before", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();

        await deck.play(19);
        expect(deck.port.heard()).toEqual([]);
        await deck.play(1);
        expect(deck.port.heard()).toEqual(["a"]);
        // Further ticks write nothing more.
        await deck.play(30);
        expect(deck.port.heard()).toEqual(["a"]);
    });

    it("sums playback across visits", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();
        await deck.play(12);
        await deck.session.next();
        await deck.play(3);
        await deck.session.previous();
        expect(deck.port.heard()).toEqual([]);

        await deck.play(8);
        expect(deck.port.heard()).toEqual(["a"]);
        expect(deck.session.secondsHeard("a")).toBe(20);
    });

    it("does not count time spent paused", async () => {
        const deck = setup(["a"]);
        await deck.session.start();
        await deck.play(10);
        deck.session.onPlaybackState(false);
        deck.advance(60);
        deck.session.tick(200, false);
        await flush();
        expect(deck.port.heard()).toEqual([]);
        expect(deck.session.secondsHeard("a")).toBe(10);

        await deck.play(10);
        expect(deck.port.heard()).toEqual(["a"]);
    });

    it("needs only half of a short song", async () => {
        const deck = setup(["a"]);
        await deck.session.start();
        await deck.play(14, 30);
        expect(deck.port.heard()).toEqual([]);
        await deck.play(1, 30);
        expect(deck.port.heard()).toEqual(["a"]);
    });

    it("counts any verdict at once, whatever the time", async () => {
        const deck = setup(["a", "b", "c", "d"]);
        await deck.session.start();
        await deck.session.like(); // a, and on to b
        await deck.session.dislike(); // b, and on to c
        await deck.session.keep(); // c stays...
        await deck.session.next(); // ...and moving on is not a quick skip
        await deck.session.love(); // d stays
        expect(deck.port.heard()).toEqual(["a", "b", "c", "d"]);
        expect(deck.session.snapshot().songId).toBe("d");
    });

    it("ignores a tick while the player still has the previous song loaded", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();
        await deck.session.next();
        // The outgoing song was 30 s long: its length must not set b's bar to 15 s.
        deck.session.onPlaybackState(true);
        deck.advance(16);
        deck.session.tick(30, true, "a");
        deck.session.tick(undefined, true, "b");
        await flush();
        expect(deck.port.heard()).toEqual([]);
    });
});

describe("laps", () => {
    it("starts lap 1 at the start point and replays quick skips from 0:00 in lap 2, with one notice", async () => {
        const deck = setup(["a", "b", "c"]);
        await deck.session.start();
        await deck.play(3);
        await deck.session.next(); // a: quick skip
        await deck.play(25);
        await deck.session.next(); // b: heard
        await deck.play(2);
        await deck.session.next(); // c: quick skip, end of lap 1

        expect(deck.port.of("load")).toEqual([
            { kind: "load", songId: "a", startFraction: DEFAULT_START_FRACTION },
            { kind: "load", songId: "b", startFraction: DEFAULT_START_FRACTION },
            { kind: "load", songId: "c", startFraction: DEFAULT_START_FRACTION },
            { kind: "load", songId: "a", startFraction: 0 },
        ]);
        expect(deck.session.snapshot()).toMatchObject({ songId: "a", lap: 2, position: 4, total: 5, notice: { kind: "lap2", count: 2 } });
        expect(deck.port.heard()).toEqual(["b"]);

        deck.session.dismissNotice();
        expect(deck.session.snapshot().notice).toBeUndefined();
    });

    it("counts a second quick skip as heard", async () => {
        const deck = setup(["a"]);
        await deck.session.start();
        await deck.session.next(); // lap 1: quick skip
        expect(deck.port.heard()).toEqual([]);
        await deck.session.next(); // lap 2: quick skip again
        expect(deck.port.heard()).toEqual(["a"]);
        expect(deck.session.snapshot().finished).toBe(true);
    });

    it("counts a song played to its end as heard, and moves on", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();
        await deck.session.onEnded("a");
        expect(deck.port.heard()).toEqual(["a"]);
        expect(deck.port.loads()).toEqual(["a", "b"]);
    });

    it("ignores an end event for a song the deck has already left", async () => {
        const deck = setup(["a", "b", "c"]);
        await deck.session.start();
        await deck.session.next();
        await deck.session.onEnded("a");
        expect(deck.port.loads()).toEqual(["a", "b"]);
        expect(deck.port.heard()).toEqual([]);
    });

    it("leaves a song heard in lap 1 out of lap 2, even one skipped quickly at first", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();
        await deck.session.next(); // a: quick skip
        await deck.session.previous(); // back to a
        await deck.session.like(); // a: heard by verdict, on to b
        await deck.session.next(); // b: quick skip, end of lap 1

        expect(deck.session.snapshot()).toMatchObject({ songId: "b", lap: 2, notice: { kind: "lap2", count: 1 } });
    });

    it("finishes with a summary and pauses, without a lap 2 when nothing was skipped quickly", async () => {
        const deck = setup(["a", "b", "c", "d"]);
        await deck.session.start();
        await deck.session.like();
        await deck.session.dislike();
        await deck.session.keep();
        await deck.session.next();
        await deck.play(20);
        await deck.session.next();

        const snapshot = deck.session.snapshot();
        expect(snapshot.finished).toBe(true);
        expect(snapshot.notice).toBeUndefined();
        expect(snapshot.summary).toEqual({ kept: 1, liked: 1, loved: 0, disliked: 1, passed: 1, unheard: 0 });
        expect(deck.port.calls.at(-1)).toEqual({ kind: "pause" });
    });
});

describe("verdicts move the deck exactly once", () => {
    it("a Dislike rates once and advances once", async () => {
        const deck = setup(["a", "b", "c"]);
        await deck.session.start();
        await deck.session.dislike();

        expect(deck.port.of("rate")).toEqual([{ kind: "rate", songId: "a", likeStatus: LikeStatus.Dislike }]);
        expect(deck.port.loads()).toEqual(["a", "b"]);
        expect(deck.session.snapshot().songId).toBe("b");
    });

    it("a Like rates once (one re-tag) and advances once", async () => {
        const deck = setup(["a", "b", "c"]);
        await deck.session.start();
        await deck.session.like();

        expect(deck.port.of("rate")).toEqual([{ kind: "rate", songId: "a", likeStatus: LikeStatus.Like }]);
        expect(deck.port.loads()).toEqual(["a", "b"]);
    });

    it("re-liking a song scrolled back to writes nothing new", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();
        await deck.session.like();
        await deck.session.previous();
        await deck.session.like();

        expect(deck.port.of("rate")).toHaveLength(1);
    });

    it("lets a song scrolled back to be re-rated", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();
        await deck.session.dislike();
        await deck.session.previous();
        await deck.session.like();

        expect(deck.port.of("rate")).toEqual([
            { kind: "rate", songId: "a", likeStatus: LikeStatus.Dislike },
            { kind: "rate", songId: "a", likeStatus: LikeStatus.Like },
        ]);
        expect(deck.session.snapshot().summary).toMatchObject({ liked: 1, disliked: 0 });
    });

    it("the notification's thumbs act like the swipes", async () => {
        const deck = setup(["a", "b", "c"]);
        await deck.session.start();
        await deck.session.rateFromRemote(LikeStatus.Dislike);
        await deck.session.rateFromRemote(LikeStatus.Like);
        expect(deck.port.loads()).toEqual(["a", "b", "c"]);
        expect(deck.port.of("rate")).toHaveLength(2);
    });

    it("Love, Keep and From the start stay on the song", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();
        await deck.session.love();
        await deck.session.keep();
        await deck.session.keep(); // one-way: a second press writes nothing
        await deck.session.fromStart();

        expect(deck.port.loads()).toEqual(["a"]);
        expect(deck.port.of("keep")).toEqual([{ kind: "keep", songId: "a" }]);
        expect(deck.port.of("seekTo")).toEqual([{ kind: "seekTo", seconds: 0 }]);
        expect(deck.session.snapshot()).toMatchObject({ songId: "a", likeStatus: LikeStatus.Love, kept: true });
    });

    it("pressing Love on a loved song takes the love back off", async () => {
        const deck = setup(["a"]);
        await deck.session.start();
        await deck.session.love();
        await deck.session.love();
        expect(deck.session.snapshot().likeStatus).toBe(LikeStatus.Neutral);
    });

    it("clearing a rating is not a verdict: an unheard song stays unheard", async () => {
        const deck = setup(["a", "b"]);
        await deck.session.start();
        await deck.session.rateFromRemote(LikeStatus.Neutral); // desktop's clear-rating shortcut
        await deck.session.settled();

        expect(deck.port.heard()).toEqual([]);
        expect(deck.port.of("rate")).toEqual([]);
        expect(deck.port.loads()).toEqual(["a"]);
    });

    it("flicks queued back to back each move one step", async () => {
        const deck = setup(["a", "b", "c", "d"]);
        await deck.session.start();
        await Promise.all([deck.session.next(), deck.session.next(), deck.session.dislike()]);
        expect(deck.port.loads()).toEqual(["a", "b", "c", "d"]);
    });
});

describe("an empty deck", () => {
    it("is finished from the start and loads nothing", async () => {
        const deck = setup([]);
        await deck.session.start();
        expect(deck.session.snapshot()).toMatchObject({ finished: true, total: 0 });
        expect(deck.port.calls).toEqual([]);
    });
});

// The care point from the hub CLAUDE.md, run through the real queries: what the playlist screen and the delete purge
// see after a deck session.
describe("against the real database", () => {
    const USER = "u1";
    const SERVER_SEED = new Date(-62135596800000); // DateTime.MinValue: a never-played UserSong from the site
    let db: GenericDb;

    beforeEach(async () => {
        const drizzleDb = drizzle(new Database(":memory:"));
        migrate(drizzleDb, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
        db = drizzleDb as unknown as GenericDb;
        await db.insert(userTable).values({ userId: USER, username: "max", version: new Date(), isCurator: false });
        await db.insert(playlistTable).values([{
            playlistId: "mix", userId: USER, name: "mix", percentUntilReplayable: 0.9, version: new Date(), isExploratory: true,
        }]);
        for (const songId of ["a", "b", "c", "d"]) {
            await db.insert(songTable).values({ songId, name: songId, fileExtension: "mp3", fileHash: `hash-${songId}`, exploratory: true });
            await db.insert(playlistSongTable).values([{ playlistSongId: `mix-${songId}`, playlistId: "mix", songId }]);
        }
        // a and b arrived with a seeded UserSong, c and d with none: both shapes must stay unheard.
        for (const songId of ["a", "b"]) {
            await db.insert(userSongTable).values([{ userId: USER, songId, lastPlayed: SERVER_SEED, version: SERVER_SEED, likeStatus: 0 }]);
        }
    });

    async function rowStates(): Promise<Record<string, AuditionRowState>> {
        const states: Record<string, AuditionRowState> = {};
        for (const row of await getPlaylistSongStates(db, USER, "mix")) {
            states[row.songId] = deriveAuditionRowState(row.exploratory, (row.likeStatus ?? LikeStatus.Neutral) as LikeStatus, row.lastPlayed);
        }
        return states;
    }

    function realPort(): AuditionPort {
        let stamp = Date.parse("2026-10-31T03:00:00Z");
        return {
            load: async () => undefined,
            resume: async () => undefined,
            pause: async () => undefined,
            seekTo: async () => undefined,
            rate: async (songId, likeStatus) => { await recordLikeStatus(db, USER, songId, likeStatus); },
            keep: async songId => { await recordKeep(db, USER, songId); },
            markHeard: async songId => { await recordPlayed(db, USER, songId, new Date(stamp += 1000)); },
            prefetch: () => undefined,
        };
    }

    it("deals out the unheard songs in playlist order", async () => {
        await recordPlayed(db, USER, "b", new Date("2026-10-30T10:00:00Z"));
        expect(await getAuditionDeckSongIds(db, USER, "mix")).toEqual(["a", "c", "d"]);
    });

    it("leaves a quickly flicked, un-verdicted song unheard: nothing a purge could take", async () => {
        let ms = 0;
        const session = new AuditionSession(await getAuditionDeckSongIds(db, USER, "mix"), realPort(), () => ms);
        await session.start();

        // a: flicked past after 2 s. c: after 19.9 s - still under the bar.
        session.onPlaybackState(true);
        ms += 2_000;
        session.tick(200, true, "a");
        await session.next();
        // b: played past the bar.
        session.onPlaybackState(true);
        ms += 20_000;
        session.tick(200, true, "b");
        await session.next();
        session.onPlaybackState(true);
        ms += 19_900;
        session.tick(200, true, "c");
        await session.next();
        // markHeard is fire-and-forget inside the deck; let its writes land.
        await session.settled();

        expect(await rowStates()).toEqual({ a: "unheard", b: "heard", c: "unheard", d: "unheard" });
        // No lastPlayed write was queued for the server for a, c or d either.
        const lastPlayedRows = (await getRequests(db, USER)).filter(r => r.requestType === RequestType.UpdateSongLastPlayed);
        expect(lastPlayedRows.map(r => r.songId)).toEqual(["b"]);
        // And the next deck deals them out again.
        expect(await getAuditionDeckSongIds(db, USER, "mix")).toEqual(["a", "c", "d"]);
    });

    // A Keep's queued row is the weak re-tag row, which the outbox sends to /songs/keep (ShuffullApp#90).
    it("records verdicts through the normal paths: one Like re-tag, a Keep, a Dislike", async () => {
        const session = new AuditionSession(await getAuditionDeckSongIds(db, USER, "mix"), realPort(), () => 0);
        await session.start();
        await session.like();
        await session.keep();
        await session.next();
        await session.dislike();
        // markHeard is fire-and-forget inside the deck; let its writes land.
        await session.settled();

        expect(await rowStates()).toMatchObject({ a: "liked", b: "kept", c: "heard", d: "unheard" });
        const requests = await getRequests(db, USER);
        expect(requests.filter(r => r.requestType === RequestType.SongRetag).map(r => [r.songId, r.payload])).toEqual([
            ["a", { model: "strong" }],
            ["b", { model: "weak" }],
        ]);
    });
});
