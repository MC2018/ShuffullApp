import { describe, expect, it } from "vitest";
import {
    buildPublishedState,
    COMMAND_MAX_AGE_MS,
    estimatePosition,
    HISTORY_MAX,
    HistoryRow,
    needsPublish,
    pendingCommand,
    PlayerSnapshot,
    PUBLISH_INTERVAL_MS,
    PublishProbe,
    QUEUED_NEXT_MAX,
    rebuildHistory,
    SCOPE_MAX_CHARS,
    scopeToSongFilters,
    songFiltersToScope,
    takeoverAction,
    TAKEOVER_MAX_AGE_MS,
} from "@/app/tools/playbackSession";
import { SongFilters } from "@/app/types/SongFilters";
import type { PlaybackCommand } from "@/app/services/api/models";

const T0 = Date.parse("2026-11-23T10:00:00.000Z");

/** History rows a second apart, the last one current at `position`. */
function rows(songIds: string[], position = 30): HistoryRow[] {
    return songIds.map((songId, i) => ({
        songId,
        timestampSeconds: i === songIds.length - 1 ? position : null,
        lastPlayed: new Date(T0 + i * 1000),
    }));
}

function snapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
    return {
        songId: "c",
        positionSeconds: 30,
        isPlaying: true,
        scope: { localOnly: false },
        recentlyPlayed: rows(["a", "b", "c"]),
        queue: [],
        ...overrides,
    };
}

describe("buildPublishedState", () => {
    it("publishes the song, position, scope, the songs before it as history and the queue", () => {
        expect(buildPublishedState(snapshot({ queue: ["q1", "q2"] }))).toEqual({
            songId: "c",
            positionSeconds: 30,
            isPlaying: true,
            scope: { localOnly: false },
            history: ["a", "b"],
            queuedNext: ["q1", "q2"],
        });
    });

    it("publishes nothing with no song loaded", () => {
        expect(buildPublishedState(snapshot({ songId: undefined }))).toBeUndefined();
    });

    it("after a Previous, the songs ahead of the current one follow the queue, in play order", () => {
        // b is current again: c was played after it and comes back on a skip once the queue is empty.
        const history: HistoryRow[] = [
            { songId: "a", timestampSeconds: null, lastPlayed: new Date(T0) },
            { songId: "b", timestampSeconds: 12, lastPlayed: new Date(T0 + 1000) },
            { songId: "c", timestampSeconds: null, lastPlayed: new Date(T0 + 2000) },
            { songId: "d", timestampSeconds: null, lastPlayed: new Date(T0 + 3000) },
        ];

        const state = buildPublishedState(snapshot({ songId: "b", recentlyPlayed: [...history].reverse(), queue: ["q"] }));

        expect(state?.history).toEqual(["a"]);
        expect(state?.queuedNext).toEqual(["q", "c", "d"]);
    });

    it("finds the current row by the song while its marker is cleared mid-change", () => {
        const history = rows(["a", "b", "c"]).map(row => ({ ...row, timestampSeconds: null }));

        expect(buildPublishedState(snapshot({ recentlyPlayed: history }))?.history).toEqual(["a", "b"]);
    });

    it("keeps the newest HISTORY_MAX songs and the first QUEUED_NEXT_MAX queued", () => {
        const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
        const queue = Array.from({ length: 120 }, (_, i) => `q${i}`);

        const state = buildPublishedState(snapshot({ songId: "s39", recentlyPlayed: rows(ids), queue }));

        expect(state?.history).toHaveLength(HISTORY_MAX);
        expect(state?.history.at(-1)).toBe("s38");
        expect(state?.queuedNext).toHaveLength(QUEUED_NEXT_MAX);
        expect(state?.queuedNext[0]).toBe("q0");
    });

    it("sends a position the API accepts", () => {
        expect(buildPublishedState(snapshot({ positionSeconds: -0.2 }))?.positionSeconds).toBe(0);
        expect(buildPublishedState(snapshot({ positionSeconds: Number.NaN }))?.positionSeconds).toBe(0);
        expect(buildPublishedState(snapshot({ positionSeconds: 12.34567 }))?.positionSeconds).toBe(12.346);
    });

    it("sends an over-long scope empty rather than have the API refuse the session", () => {
        const scope = { whitelists: { playlistIds: Array.from({ length: SCOPE_MAX_CHARS }, (_, i) => `p${i}`) } };

        expect(buildPublishedState(snapshot({ scope }))?.scope).toEqual({});
    });
});

describe("needsPublish", () => {
    const probe = (overrides: Partial<PublishProbe> = {}): PublishProbe =>
        ({ songId: "c", isPlaying: true, positionSeconds: 30, revision: 0, ...overrides });
    const last = { probe: probe(), at: T0 };

    it("publishes the first state, and never without a song", () => {
        expect(needsPublish(undefined, probe(), T0)).toBe(true);
        expect(needsPublish(undefined, probe({ songId: undefined }), T0)).toBe(false);
    });

    it("publishes a track change, play or pause and a scope or queue change at once", () => {
        expect(needsPublish(last, probe({ songId: "d", positionSeconds: 0 }), T0 + 500)).toBe(true);
        expect(needsPublish(last, probe({ isPlaying: false }), T0 + 500)).toBe(true);
        expect(needsPublish(last, probe({ revision: 1, positionSeconds: 30.5 }), T0 + 500)).toBe(true);
    });

    it("publishes a seek, but not a position moving with the clock", () => {
        expect(needsPublish(last, probe({ positionSeconds: 35 }), T0 + 5000)).toBe(false);
        expect(needsPublish(last, probe({ positionSeconds: 90 }), T0 + 5000)).toBe(true);
        expect(needsPublish(last, probe({ positionSeconds: 10 }), T0 + 5000)).toBe(true);
    });

    it("refreshes a playing session every interval, and leaves a paused one alone", () => {
        expect(needsPublish(last, probe({ positionSeconds: 39.9 }), T0 + PUBLISH_INTERVAL_MS - 100)).toBe(false);
        expect(needsPublish(last, probe({ positionSeconds: 40 }), T0 + PUBLISH_INTERVAL_MS)).toBe(true);

        const paused = { probe: probe({ isPlaying: false }), at: T0 };
        expect(needsPublish(paused, probe({ isPlaying: false }), T0 + 10 * PUBLISH_INTERVAL_MS)).toBe(false);
        expect(needsPublish(paused, probe({ isPlaying: false, positionSeconds: 60 }), T0 + 1000)).toBe(true);
    });
});

describe("estimatePosition", () => {
    it("carries a playing song on by the local time since the answer arrived", () => {
        expect(estimatePosition({ estimatedPositionSeconds: 42.5, isPlaying: true }, T0, T0 + 3000)).toBe(45.5);
    });

    it("holds a paused song still, and never goes back for a clock that did", () => {
        expect(estimatePosition({ estimatedPositionSeconds: 42.5, isPlaying: false }, T0, T0 + 3000)).toBe(42.5);
        expect(estimatePosition({ estimatedPositionSeconds: 42.5, isPlaying: true }, T0, T0 - 3000)).toBe(42.5);
    });
});

describe("rebuildHistory (taking over)", () => {
    it("writes the history oldest first, then the song as current at the position, newest", () => {
        const rebuilt = rebuildHistory({ songId: "c", history: ["a", "b"] }, 42.5, T0, () => true);

        expect(rebuilt).toEqual([
            { songId: "a", timestampSeconds: null, lastPlayed: new Date(T0 - 2000) },
            { songId: "b", timestampSeconds: null, lastPlayed: new Date(T0 - 1000) },
            { songId: "c", timestampSeconds: 42.5, lastPlayed: new Date(T0) },
        ]);
    });

    it("so building the state again publishes the same history", () => {
        const rebuilt = rebuildHistory({ songId: "c", history: ["a", "b", "a"] }, 10, T0, () => true);

        expect(buildPublishedState(snapshot({ recentlyPlayed: rebuilt }))?.history).toEqual(["a", "b", "a"]);
    });

    it("leaves out songs this device doesn't have", () => {
        const rebuilt = rebuildHistory({ songId: "c", history: ["a", "gone", "b"] }, 0, T0, id => id !== "gone");

        expect(rebuilt.map(row => row.songId)).toEqual(["a", "b", "c"]);
    });
});

describe("scope", () => {
    it("round-trips the song filters", () => {
        const filters = new SongFilters();
        filters.localOnly = true;
        filters.whitelists.playlistIds = ["p1"];
        filters.blacklists.artistIds = ["ar1"];
        filters.heavinessMin = 3;
        filters.genreJam = true;

        const back = scopeToSongFilters(songFiltersToScope(filters));

        expect(back).toBeInstanceOf(SongFilters);
        expect(back).toEqual(filters);
    });

    it("drops what the filters don't know or can't use, so another device's scope can't break this one", () => {
        const back = scopeToSongFilters({
            localOnly: "yes",
            heavinessMax: "9",
            whitelists: { playlistIds: ["p1", 7, null], genreIds: "rock" },
            blacklists: null,
            somethingNew: true,
        });

        expect(back).toEqual(Object.assign(new SongFilters(), {
            whitelists: { ...new SongFilters().whitelists, playlistIds: ["p1"] },
        }));
        expect("somethingNew" in back).toBe(false);
    });
});

describe("takeoverAction", () => {
    const at = new Date(T0);
    const session = { takenOverBy: "laptop", takenOverAt: at };

    it("pauses for a fresh takeover by another device, once", () => {
        expect(takeoverAction(session, "phone", undefined, new Date(T0 + 1000))).toBe("pause");
        expect(takeoverAction(session, "phone", T0, new Date(T0 + 1000))).toBeUndefined();
    });

    it("marks an old one seen without pausing", () => {
        expect(takeoverAction(session, "phone", undefined, new Date(T0 + TAKEOVER_MAX_AGE_MS + 1))).toBe("stale");
    });

    it("ignores no takeover and one by this device", () => {
        expect(takeoverAction({ takenOverBy: null, takenOverAt: null }, "phone", undefined, at)).toBeUndefined();
        expect(takeoverAction(null, "phone", undefined, at)).toBeUndefined();
        expect(takeoverAction(session, "laptop", undefined, at)).toBeUndefined();
    });
});

describe("pendingCommand", () => {
    const command = (overrides: Partial<PlaybackCommand> = {}): PlaybackCommand =>
        ({ commandId: "cmd-1", kind: "pause", seekSeconds: null, at: new Date(T0), ...overrides });

    it("hands out a fresh command once", () => {
        expect(pendingCommand({ command: command() }, new Set(), new Date(T0 + 500))?.commandId).toBe("cmd-1");
        expect(pendingCommand({ command: command() }, new Set(["cmd-1"]), new Date(T0 + 500))).toBeUndefined();
    });

    it("skips an old command, none, and a seek without a position", () => {
        expect(pendingCommand({ command: command() }, new Set(), new Date(T0 + COMMAND_MAX_AGE_MS + 1))).toBeUndefined();
        expect(pendingCommand({ command: null }, new Set(), new Date(T0))).toBeUndefined();
        expect(pendingCommand({ command: command({ kind: "seek" }) }, new Set(), new Date(T0))).toBeUndefined();
        expect(pendingCommand({ command: command({ kind: "seek", seekSeconds: 90 }) }, new Set(), new Date(T0))?.seekSeconds).toBe(90);
    });
});
