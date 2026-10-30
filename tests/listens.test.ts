import { describe, expect, it } from "vitest";
import {
    clockAt,
    clockSeconds,
    finishedListen,
    listenContext,
    ListenContextInput,
    listenPlatform,
    listenToTakeOver,
    newListenClock,
    OpenListenFields,
    TAKE_OVER_MARGIN_SECONDS,
} from "@/app/tools/listens";

// The pure parts of the listen log (ShuffullApp#57): the seconds a listen reports must be actual playback only.

describe("listen clock: counts only actual playback", () => {
    it("runs only while playing", () => {
        let clock = newListenClock(false, 0);
        clock = clockAt(clock, true, 1_000);   // loaded, then playing at 1s
        expect(clockSeconds(clock, 11_000)).toBe(10);
    });

    it("a pause adds nothing", () => {
        let clock = newListenClock(true, 0);
        clock = clockAt(clock, false, 30_000);  // paused at 30s
        expect(clockSeconds(clock, 90_000)).toBe(30);
        clock = clockAt(clock, true, 90_000);   // resumed after a minute
        expect(clockSeconds(clock, 100_000)).toBe(40);
    });

    it("buffering and a seek's rebuffer add nothing, and a seek forward adds only the time really played", () => {
        let clock = newListenClock(true, 0);
        clock = clockAt(clock, false, 5_000);   // seek: Buffering at 5s
        clock = clockAt(clock, true, 7_000);    // playing again 2s later, now 60s further into the track
        clock = clockAt(clock, false, 10_000);  // buffering
        clock = clockAt(clock, true, 15_000);
        expect(clockSeconds(clock, 20_000)).toBe(5 + 3 + 5);
    });

    it("repeated reports of the same state change nothing", () => {
        const clock = newListenClock(true, 0);
        expect(clockAt(clock, true, 5_000)).toBe(clock);
        const paused = clockAt(clock, false, 5_000);
        expect(clockAt(paused, false, 9_000)).toBe(paused);
    });

    it("a device clock stepping backwards adds nothing rather than taking seconds away", () => {
        let clock = newListenClock(true, 10_000);
        clock = clockAt(clock, false, 20_000);
        clock = clockAt(clock, true, 20_000);
        expect(clockSeconds(clock, 15_000)).toBe(10);
    });
});

describe("listenContext", () => {
    const input = (over: Partial<ListenContextInput> = {}): ListenContextInput => ({
        songExploratory: false,
        unheardOnly: false,
        genreJam: false,
        playlistIds: [],
        scopePlaylistExploratory: false,
        ...over,
    });

    it("a still-exploratory song is an audition wherever it plays", () => {
        expect(listenContext(input({ songExploratory: true, playlistIds: ["p1"] })))
            .toEqual({ context: "audition", playlistId: "p1" });
        expect(listenContext(input({ songExploratory: true, genreJam: true })).context).toBe("audition");
    });

    it("a song played from an audition playlist is an audition, even once kept", () => {
        expect(listenContext(input({ scopePlaylistExploratory: true, playlistIds: ["mix"] })))
            .toEqual({ context: "audition", playlistId: "mix" });
    });

    it("an audition scope (unheardOnly) is an audition", () => {
        expect(listenContext(input({ unheardOnly: true })).context).toBe("audition");
    });

    it("a caller's audition override always wins; another override beats the derived context", () => {
        expect(listenContext(input({ override: "audition", genreJam: true })).context).toBe("audition");
        expect(listenContext(input({ override: "other", playlistIds: ["p1"] })))
            .toEqual({ context: "other", playlistId: "p1" });
        // But an exploratory song stays an audition whatever the caller says.
        expect(listenContext(input({ override: "playlist", songExploratory: true })).context).toBe("audition");
    });

    it("a genre jam, then one playlist, then other", () => {
        expect(listenContext(input({ genreJam: true })).context).toBe("genreJam");
        expect(listenContext(input({ playlistIds: ["p1"] }))).toEqual({ context: "playlist", playlistId: "p1" });
        expect(listenContext(input({ playlistIds: ["p1", "p2"] }))).toEqual({ context: "other", playlistId: null });
        expect(listenContext(input())).toEqual({ context: "other", playlistId: null });
    });
});

describe("listenPlatform", () => {
    it("is the OS, except the Electron app", () => {
        expect(listenPlatform("android", false)).toBe("android");
        expect(listenPlatform("ios", false)).toBe("ios");
        expect(listenPlatform("web", false)).toBe("web");
        expect(listenPlatform("web", true)).toBe("desktop");
    });
});

describe("finishedListen: the wire item", () => {
    const open: OpenListenFields = {
        listenId: "l1",
        userId: "u1",
        songId: "s1",
        startedAt: new Date("2026-10-31T01:00:00.000Z"),
        songDurationSeconds: 214.5,
        context: "playlist",
        playlistId: "p1",
        platform: "android",
    };
    const start = open.startedAt.getTime();

    it("carries the listen as the server's ListenItem", () => {
        expect(finishedListen(open, start + 200_000, 199.25, "finished")).toEqual({
            listenId: "l1",
            songId: "s1",
            startedAt: "2026-10-31T01:00:00.000Z",
            endedAt: "2026-10-31T01:03:20.000Z",
            secondsListened: 199.25,
            songDurationSeconds: 214.5,
            endReason: "finished",
            context: "playlist",
            playlistId: "p1",
            platform: "android",
            userId: "u1",
        });
    });

    it("rounds seconds to the millisecond and never sends a negative or non-finite count", () => {
        expect(finishedListen(open, start + 10_000, 1.23456, "skipped").secondsListened).toBe(1.235);
        expect(finishedListen(open, start + 10_000, -3, "skipped").secondsListened).toBe(0);
        expect(finishedListen(open, start + 10_000, Number.NaN, "skipped").secondsListened).toBe(0);
    });

    it("stretches the span to cover the seconds, so the server's seconds ≤ span check can't reject it", () => {
        // The device clock stepped back mid-song: the end reads before the start.
        const item = finishedListen(open, start - 60_000, 30, "stopped");
        expect(Date.parse(item.endedAt) - Date.parse(item.startedAt)).toBe(30_000);
    });

    it("sends an unknown or nonsense duration as null", () => {
        for (const songDurationSeconds of [null, 0, -1, Number.POSITIVE_INFINITY]) {
            expect(finishedListen({ ...open, songDurationSeconds }, start, 0, "skipped").songDurationSeconds).toBeNull();
        }
    });
});

describe("listenToTakeOver: the old run's listen that is still the play going on (ShuffullApp#147)", () => {
    const NOW = 1_000_000;
    const orphan = (listenId: string, songId: string, secondsAgo: number) =>
        ({ listenId, songId, checkpointedAt: new Date(NOW - secondsAgo * 1000) });

    it("takes the playing song's listen once the position is past the time since its checkpoint", () => {
        const a = orphan("a", "s1", 8);
        expect(listenToTakeOver([a], { songId: "s1", positionSeconds: 8 + TAKE_OVER_MARGIN_SECONDS + 0.01 }, NOW)).toBe(a);
    });

    it("takes none when the song could have started over since the checkpoint", () => {
        const a = orphan("a", "s1", 8);
        expect(listenToTakeOver([a], { songId: "s1", positionSeconds: 8 }, NOW)).toBeUndefined();
        expect(listenToTakeOver([a], { songId: "s1", positionSeconds: 8 + TAKE_OVER_MARGIN_SECONDS }, NOW)).toBeUndefined();
        expect(listenToTakeOver([a], { songId: "s1", positionSeconds: 0 }, NOW)).toBeUndefined();
    });

    it("takes none for another song, an unknown position, or no orphans", () => {
        expect(listenToTakeOver([orphan("a", "s1", 5)], { songId: "s2", positionSeconds: 120 }, NOW)).toBeUndefined();
        expect(listenToTakeOver([orphan("a", "s1", 5)], { songId: "s1", positionSeconds: NaN }, NOW)).toBeUndefined();
        expect(listenToTakeOver([], { songId: "s1", positionSeconds: 120 }, NOW)).toBeUndefined();
    });

    it("of several for the song, takes the newest checkpoint, and only if it qualifies", () => {
        const old = orphan("old", "s1", 3_600);
        const recent = orphan("recent", "s1", 5);
        const other = orphan("other", "s2", 1);
        expect(listenToTakeOver([old, recent, other], { songId: "s1", positionSeconds: 60 }, NOW)).toBe(recent);
        // The newest is too close to the start; an older one is never taken in its place.
        expect(listenToTakeOver([old, orphan("new", "s1", 50)], { songId: "s1", positionSeconds: 40 }, NOW)).toBeUndefined();
    });
});
