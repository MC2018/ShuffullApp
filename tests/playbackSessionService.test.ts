import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSession, PlaybackSessionsResponse } from "@/app/services/api/models";

// PlaybackSessionService's own state (ShuffullApp#194): the takeover pause and the publish after it, the takeover
// hand-off back to the server, the 404 re-check-in and the backoffs, remote commands, and takeOver's retry on 409. The
// player, the database, the device row and the socket are stubbed; the pure decisions are tested in playbackSession.test.ts.

const player = {
    songId: "s1" as string | undefined,
    isPlaying: vi.fn(async () => true),
    position: 10,
};

vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock("@/app/tools/utils", () => import("@/app/tools/pure"));
vi.mock("@microsoft/signalr", () => {
    class HubConnectionBuilder {
        withUrl() { return this; }
        withAutomaticReconnect() { return this; }
        configureLogging() { return this; }
        build() {
            // The live channel never connects here, so the service polls.
            return {
                on() {}, onreconnecting() {}, onreconnected() {}, onclose() {},
                start: () => Promise.reject(new Error("offline")),
                stop: () => Promise.resolve(),
                state: "Disconnected",
            };
        }
    }
    return { HubConnectionBuilder, HubConnectionState: { Connected: "Connected" }, LogLevel: { Error: 4, Warning: 3 } };
});
const media = {
    useActiveSong: { getState: () => ({ songId: player.songId }) },
    isPlaying: () => player.isPlaying(),
    getPosition: vi.fn(async () => player.position),
    getTransportRevision: () => 0,
    getSongFilters: vi.fn(async () => ({})),
    getQueue: () => [],
    pause: vi.fn(async () => { player.isPlaying.mockImplementation(async () => false); }),
    play: vi.fn(async () => undefined),
    skip: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
    seekTo: vi.fn(async () => undefined),
    adoptPlayback: vi.fn(async () => undefined),
};
vi.mock("@/app/services/media-manager", () => ({ MediaManager: media }));
const queries = {
    getRecentlyPlayedSongs: vi.fn(async () => []),
    getSong: vi.fn(async (_db: unknown, songId: string) => ({ songId })),
};
vi.mock("@/app/services/db/queries", () => ({ default: queries }));
const device = {
    deviceIdOrNull: vi.fn(async () => "self"),
    ensureDeviceCheckedIn: vi.fn(async (_force?: boolean) => true),
};
vi.mock("@/app/services/device", () => device);

const { startPlaybackSessions, takeOverPlayback } = await import("@/app/services/playback/playbackSessions");
const { ApiStatusFailureError } = await import("@/app/services/api/errors");

const T0 = Date.parse("2026-11-23T10:00:00.000Z");

function session(overrides: Partial<PlaybackSession> = {}): PlaybackSession {
    return {
        deviceId: "self", songId: "s1", positionSeconds: 10, positionAt: new Date(T0), isPlaying: true,
        estimatedPositionSeconds: 10, scope: {}, history: [], queuedNext: [], updatedAt: new Date(T0),
        takenOverBy: null, takenOverAt: null, command: null, ...overrides,
    };
}

function sessions(...list: PlaybackSession[]): PlaybackSessionsResponse {
    return {
        serverTime: new Date(Date.now()),
        devices: list.map(s => ({ deviceId: s.deviceId, name: s.deviceId, platform: null, online: true, session: s })),
    } as PlaybackSessionsResponse;
}

function makeApi() {
    return {
        getBaseURL: () => "http://api",
        accessToken: async () => "token",
        playbackSessionPut: vi.fn(async (_id: string, _body: { isPlaying: boolean; seenTakenOverAt?: string | null }) => undefined),
        playbackSessionsGet: vi.fn(async () => sessions(session())),
        playbackCommandAck: vi.fn(async () => undefined),
        playbackTakeover: vi.fn(async () => session({ deviceId: "phone" })),
        playbackCommand: vi.fn(async () => undefined),
    };
}

let api: ReturnType<typeof makeApi>;
let stop: (() => void) | undefined;

async function start() {
    stop = startPlaybackSessions({} as never, api as never);
    // The device id read, then the first sessions read it schedules, then acting on it.
    for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(0);
    }
}

/** The bodies PUT so far. */
const puts = () => api.playbackSessionPut.mock.calls.map(call => call[1]);

beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    player.songId = "s1";
    player.position = 10;
    player.isPlaying.mockImplementation(async () => true);
    device.ensureDeviceCheckedIn.mockImplementation(async () => true);
    api = makeApi();
});

afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("publishing", () => {
    it("publishes what plays, with no takeover to acknowledge", async () => {
        await start();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(puts()).toHaveLength(1);
        expect(puts()[0]).toMatchObject({ songId: "s1", isPlaying: true, positionSeconds: 10, seenTakenOverAt: null });
    });

    it("checks in again once on a 404, then backs off without forcing another check-in", async () => {
        api.playbackSessionPut.mockRejectedValue(new ApiStatusFailureError("put", { status: 404 }));
        await start();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(api.playbackSessionPut).toHaveBeenCalledTimes(2);
        expect(device.ensureDeviceCheckedIn).toHaveBeenCalledWith(true);

        // Next try 10 s after the failure: one PUT, no forced check-in.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.playbackSessionPut).toHaveBeenCalledTimes(3);
        expect(device.ensureDeviceCheckedIn.mock.calls.filter(call => call[0] === true)).toHaveLength(1);

        // Then 20 s, not 10.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.playbackSessionPut).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.playbackSessionPut).toHaveBeenCalledTimes(4);
    });

    it("polls less often while the sessions can't be read", async () => {
        api.playbackSessionsGet.mockRejectedValue(new ApiStatusFailureError("get", { status: 404 }));
        await start();
        expect(api.playbackSessionsGet).toHaveBeenCalledTimes(1);

        // Failed reads wait 10 s, then 20 s, then 40 s. (Checked half a second after each, once the read has run.)
        await vi.advanceTimersByTimeAsync(10_500);
        expect(api.playbackSessionsGet).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.playbackSessionsGet).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.playbackSessionsGet).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(api.playbackSessionsGet).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.playbackSessionsGet).toHaveBeenCalledTimes(4);
    });
});

describe("being taken over", () => {
    const takenOver = () => session({ takenOverBy: "desktop", takenOverAt: new Date(Date.now()) });

    it("pauses, publishes the paused state once without clearing the takeover, then clears it on resume", async () => {
        await start();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(puts()).toHaveLength(1);

        const taken = takenOver();
        api.playbackSessionsGet.mockResolvedValue(sessions(taken));
        await vi.advanceTimersByTimeAsync(10_000); // the poll reads the takeover
        expect(media.pause).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1_000);
        const paused = puts().filter(body => !body.isPlaying);
        expect(paused).toHaveLength(1);
        expect(paused[0].seenTakenOverAt).toBeNull();

        // Paused and taken over: nothing more, however long.
        const count = puts().length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(puts()).toHaveLength(count);

        // Playing here again: published as playing, acknowledging the takeover so the server clears it.
        player.isPlaying.mockImplementation(async () => true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(puts().at(-1)).toMatchObject({ isPlaying: true, seenTakenOverAt: taken.takenOverAt!.toISOString() });
    });

    it("drops a probe that read 'playing' from before the pause", async () => {
        await start();
        await vi.advanceTimersByTimeAsync(1_000);
        const before = puts().length;

        // The next probe's isPlaying read is still out when the takeover arrives, and answers "playing".
        let answer: (playing: boolean) => void = () => undefined;
        player.isPlaying.mockImplementationOnce(() => new Promise<boolean>(resolve => { answer = resolve; }));
        player.position = 40; // a seek, so this probe would publish
        await vi.advanceTimersByTimeAsync(1_000);

        api.playbackSessionsGet.mockResolvedValue(sessions(takenOver()));
        await vi.advanceTimersByTimeAsync(9_000);
        expect(media.pause).toHaveBeenCalledTimes(1);
        answer(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(puts().slice(before).filter(body => body.isPlaying)).toEqual([]);

        // The next probe sees the pause and publishes it; the device stays taken over.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(puts().slice(before)).toEqual([expect.objectContaining({ isPlaying: false, seenTakenOverAt: null })]);
    });

    it("marks an old takeover seen without pausing", async () => {
        api.playbackSessionsGet.mockResolvedValue(sessions(session({ takenOverBy: "desktop", takenOverAt: new Date(T0 - 120_000) })));
        await start();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(media.pause).not.toHaveBeenCalled();
        expect(puts()[0]).toMatchObject({ isPlaying: true, seenTakenOverAt: new Date(T0 - 120_000).toISOString() });
    });
});

describe("remote commands", () => {
    it("carries a command out once and acks it, and skips a kind it doesn't know", async () => {
        const command = { commandId: "c1", kind: "seek", seekSeconds: 90, at: new Date(T0) };
        api.playbackSessionsGet.mockResolvedValue(sessions(session({ command })));
        await start();
        expect(media.seekTo).toHaveBeenCalledWith(90);
        expect(api.playbackCommandAck).toHaveBeenCalledWith("self", "c1");

        await vi.advanceTimersByTimeAsync(10_000);
        expect(media.seekTo).toHaveBeenCalledTimes(1);

        api.playbackSessionsGet.mockResolvedValue(sessions(session({ command: { ...command, commandId: "c2", kind: "shuffle" } })));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(api.playbackCommandAck).toHaveBeenCalledTimes(1);
    });
});

describe("taking over", () => {
    it("reads the source again after a 409 and carries on from what the server paused", async () => {
        const source = session({ deviceId: "phone", songId: "s9", history: ["s7", "s8"], queuedNext: ["s10"] });
        api.playbackSessionsGet.mockResolvedValue(sessions(session(), source));
        api.playbackTakeover
            .mockRejectedValueOnce(new ApiStatusFailureError("takeover", { status: 409 }))
            .mockResolvedValueOnce({ ...source, positionSeconds: 103, isPlaying: false });
        await start();

        await takeOverPlayback("phone");

        expect(api.playbackTakeover).toHaveBeenCalledTimes(2);
        expect(media.adoptPlayback).toHaveBeenCalledWith(expect.objectContaining({
            songId: "s9", positionSeconds: 103, history: ["s7", "s8"], queuedNext: ["s10"],
        }));
    });

    it("refuses a device with nothing loaded, or a song this device doesn't have, before asking the server", async () => {
        api.playbackSessionsGet.mockResolvedValue(sessions(session(), session({ deviceId: "phone", songId: null })));
        await start();
        await expect(takeOverPlayback("phone")).rejects.toThrow("isn't playing anything");

        api.playbackSessionsGet.mockResolvedValue(sessions(session(), session({ deviceId: "phone", songId: "s9" })));
        queries.getSong.mockResolvedValueOnce(undefined as never);
        await expect(takeOverPlayback("phone")).rejects.toThrow("isn't on this device yet");
        expect(api.playbackTakeover).not.toHaveBeenCalled();
    });
});
