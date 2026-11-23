import { HubConnection, HubConnectionBuilder, HubConnectionState, ILogger, LogLevel } from "@microsoft/signalr";
import { AppState } from "react-native";
import { create } from "zustand";
import { ApiClient } from "../api/ApiClient";
import { ApiStatusFailureError } from "../api/errors";
import { PlaybackCommandKind, PlaybackDevice, PlaybackSession, PlaybackSessionsResponse } from "../api/models";
import { GenericDb } from "../db/GenericDb";
import DbQueries from "../db/queries";
import { deviceIdOrNull, ensureDeviceCheckedIn } from "../device";
import { MediaManager } from "../media-manager";
import {
    buildPublishedState,
    estimatePosition,
    KnownPlaybackCommand,
    LastPublish,
    needsPublish,
    pendingCommand,
    PUBLISH_INTERVAL_MS,
    PublishProbe,
    scopeToSongFilters,
    songFiltersToScope,
    takeoverAction,
} from "../../tools/playbackSession";
import { acquireTabLock } from "../../tools/tabLock";
import { generateId } from "../../tools/utils";
import { log } from "../../tools/log";

// Cross-device playback (ShuffullApp#194): this install publishes what it plays as its playback session, listens on the
// live channel for changes to any of the user's sessions, pauses when another device takes over, and carries out
// remote commands. The decisions are in tools/playbackSession.ts; this file wires them to the player, the API and the
// socket. Everything here is best effort: a session is live state, not a user decision, so nothing goes through the
// outbox, and a failure waits for the next tick.

/** How often the player is looked at to decide whether to publish. Cheap: the full state is read only when needed. */
const PROBE_INTERVAL_MS = 1_000;
/**
 * After a failed publish, the next try waits this long, doubling with each failure in a row up to the max. An offline
 * device, or an API without playback sessions (any server older than Shuffull#138), then costs a request every few
 * minutes rather than every few seconds.
 */
const PUBLISH_RETRY_MIN_MS = PUBLISH_INTERVAL_MS;
const PUBLISH_RETRY_MAX_MS = 5 * 60_000;
/** With the live channel down, the sessions are read this often instead, backing off the same way while reads fail. */
const POLL_INTERVAL_MS = PUBLISH_INTERVAL_MS;
const POLL_RETRY_MAX_MS = 5 * 60_000;
/** "Session changed" signals that arrive together (a takeover touches two sessions) are read once. */
const REFRESH_DEBOUNCE_MS = 150;
/** Between attempts to open the live channel after one failed, doubling up to the max. */
const CONNECT_RETRY_MIN_MS = 5_000;
const CONNECT_RETRY_MAX_MS = 5 * 60_000;
/** The command ids already carried out, kept to this many. */
const HANDLED_COMMANDS_MAX = 50;
/** Two tabs of the web app share one device id: only the tab holding this lock plays as the device. */
const TAB_LOCK_NAME = "shuffull-playback-device";

/** The wait before the next try after `failures` failures in a row: `min`, doubling per failure, up to `max`. */
function backoffMs(failures: number, min: number, max: number): number {
    return Math.min(max, min * 2 ** Math.max(0, failures - 1));
}

export interface PlaybackDevicesState {
    /** This install's device id, once read. */
    selfDeviceId: string | undefined;
    /** The user's other devices, each with its session if it has published one. */
    devices: PlaybackDevice[];
    /** When the last answer arrived (local clock, ms): what estimatedPositionOf counts from. */
    receivedAt: number | undefined;
    /** The live channel is connected, so `devices` changes within about a second. */
    live: boolean;
    /** This tab plays as this device. False only in a second web tab; that tab can't take over. */
    leader: boolean;
}

const initialState: PlaybackDevicesState = { selfDeviceId: undefined, devices: [], receivedAt: undefined, live: false, leader: false };

/** The user's other devices and what each is playing, for the devices sheet and the remote player bar. */
export const usePlaybackDevices = create<PlaybackDevicesState>(() => initialState);

// No caller yet for estimatedPositionOf, takeOverPlayback, sendPlaybackCommand or refreshPlaybackDevices: they are what
// the devices sheet (ShuffullApp#195) and the remote player bar (ShuffullApp#196) are built on.

/** Where a device's song is now, carried on from the last answer while it plays. */
export function estimatedPositionOf(session: PlaybackSession, now: number = Date.now()): number {
    const { receivedAt } = usePlaybackDevices.getState();
    return estimatePosition(session, receivedAt ?? now, now);
}

let active: PlaybackSessionService | undefined;

/** Starts this session's publisher and live channel (SyncManagerProvider, once per signed-in session). Returns the stop. */
export function startPlaybackSessions(db: GenericDb, api: ApiClient): () => void {
    const service = new PlaybackSessionService(db, api);
    active = service;
    service.start();
    return () => {
        service.stop();
        if (active === service) {
            active = undefined;
        }
        usePlaybackDevices.setState(initialState);
    };
}

/**
 * Moves another device's playback here: it pauses there and carries on here at the same second, with its scope,
 * history and queue. Throws an Error whose message can be shown when it can't.
 */
export function takeOverPlayback(sourceDeviceId: string): Promise<void> {
    if (active == undefined) {
        return Promise.reject(new Error("Not signed in."));
    }
    return active.takeOver(sourceDeviceId);
}

/** Sends a remote-control command to another device. Throws when the server didn't take it. */
export function sendPlaybackCommand(deviceId: string, kind: PlaybackCommandKind, seekSeconds?: number): Promise<void> {
    if (active == undefined) {
        return Promise.reject(new Error("Not signed in."));
    }
    return active.sendCommand(deviceId, kind, seekSeconds);
}

/** Reads every device's session now. */
export function refreshPlaybackDevices(): void {
    active?.scheduleRefresh(0);
}

class PlaybackSessionService {
    private stopped = false;
    private leader = false;
    private selfDeviceId: string | undefined;
    private readonly timers: ReturnType<typeof setInterval>[] = [];
    private releaseTabLock: (() => void) | undefined;
    private appState: { remove: () => void } | undefined;

    // Publishing.
    private probing = false;
    private lastPublish: LastPublish | undefined;
    private publishFailedAt: number | undefined;
    private publishFailures = 0;
    /** A 404 forced a re-check-in since the last publish that worked: another 404 is the API, not the device row. */
    private forcedCheckIn = false;
    /** Paused by a takeover: nothing is published as the active player until playback starts here again. */
    private takenOver = false;
    /**
     * The paused state is still to be published once after a takeover. A publish that read "playing" just before the
     * pause can land on the server after the takeover and mark this device playing again; this one corrects it.
     */
    private publishPausedState = false;
    /** Bumped by each takeover pause, so a probe whose reads straddle one is dropped rather than published. */
    private takeoverEpoch = 0;
    private pausingForTakeover = false;
    /** The takenOverAt last acted on (ms), and the same as sent back in `seenTakenOverAt` until a publish carries it. */
    private handledTakenOverAt: number | undefined;
    private unseenTakenOverAt: string | undefined;

    // Reading.
    private connection: HubConnection | undefined;
    private connectRetryMs = CONNECT_RETRY_MIN_MS;
    private connectTimer: ReturnType<typeof setTimeout> | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private refreshing: Promise<void> | undefined;
    private refreshAgain = false;
    private pollFailures = 0;
    /** With the live channel down and reads failing, this many poll ticks are skipped before the next read. */
    private pollTicksToSkip = 0;
    private readonly handledCommands: string[] = [];

    constructor(private readonly db: GenericDb, private readonly api: ApiClient) {}

    start(): void {
        void deviceIdOrNull().then(id => {
            if (this.stopped || id == null) {
                return;
            }
            this.selfDeviceId = id;
            usePlaybackDevices.setState({ selfDeviceId: id });
            this.releaseTabLock = acquireTabLock(TAB_LOCK_NAME, () => {
                if (this.stopped) {
                    return;
                }
                this.leader = true;
                usePlaybackDevices.setState({ leader: true });
                log.info("playback-sessions", "this tab plays as the device");
            });
            this.timers.push(setInterval(() => void this.probe(), PROBE_INTERVAL_MS));
            this.timers.push(setInterval(() => {
                if (this.connection?.state === HubConnectionState.Connected) {
                    return;
                }
                if (this.pollTicksToSkip > 0) {
                    this.pollTicksToSkip--;
                } else {
                    this.scheduleRefresh(0);
                }
            }, POLL_INTERVAL_MS));
            this.appState = AppState.addEventListener("change", state => {
                if (state === "active") {
                    this.scheduleRefresh(0);
                }
            });
            void this.connect(id);
            this.scheduleRefresh(0);
        });
    }

    stop(): void {
        this.stopped = true;
        this.timers.forEach(clearInterval);
        clearTimeout(this.connectTimer);
        clearTimeout(this.refreshTimer);
        this.appState?.remove();
        this.releaseTabLock?.();
        void this.connection?.stop().catch(() => undefined);
    }

    // ---- Publishing ----

    private async probe(): Promise<void> {
        if (!this.leader || this.probing || this.stopped || this.selfDeviceId == undefined) {
            return;
        }
        this.probing = true;
        try {
            const epoch = this.takeoverEpoch;
            const probe: PublishProbe = {
                songId: MediaManager.useActiveSong.getState().songId,
                isPlaying: await MediaManager.isPlaying(),
                positionSeconds: await MediaManager.getPosition(),
                revision: MediaManager.getTransportRevision(),
            };
            if (this.pausingForTakeover || epoch !== this.takeoverEpoch) {
                // A takeover arrived during the reads, which may say "playing" from before its pause. The next tick reads again.
                return;
            }
            const now = Date.now();
            if (this.takenOver) {
                if (!probe.isPlaying) {
                    if (this.publishPausedState && this.mayPublish(now)) {
                        await this.publish(this.selfDeviceId, probe, epoch, false);
                    }
                    return;
                }
                // Playback started here again, so this device is a player again: publish, which also clears the takeover.
                this.takenOver = false;
                this.publishPausedState = false;
                this.lastPublish = undefined;
            }

            if (this.mayPublish(now) && needsPublish(this.lastPublish, probe, now)) {
                await this.publish(this.selfDeviceId, probe, epoch, true);
            }
        } catch (e) {
            // The player isn't set up yet, or the database is mid-swap: the next tick tries again.
            log.debug("playback-sessions", "could not read the player", e);
        } finally {
            this.probing = false;
        }
    }

    /** Whether the backoff after failed publishes has run out. */
    private mayPublish(now: number): boolean {
        return this.publishFailedAt == undefined
            || now - this.publishFailedAt >= backoffMs(this.publishFailures, PUBLISH_RETRY_MIN_MS, PUBLISH_RETRY_MAX_MS);
    }

    /**
     * Publishes `probe` with the rest of the state. `ackTakeover` sends back the takeover this device last acted on,
     * which clears it on the server: true when this device plays as itself, false for the one paused publish after a
     * takeover, which only corrects the playing flag and the position. `epoch` is takeoverEpoch when the probe was read.
     */
    private async publish(deviceId: string, probe: PublishProbe, epoch: number, ackTakeover: boolean): Promise<void> {
        const state = buildPublishedState({
            ...probe,
            scope: songFiltersToScope(await MediaManager.getSongFilters()),
            recentlyPlayed: await DbQueries.getRecentlyPlayedSongs(this.db),
            queue: MediaManager.getQueue(),
        });
        if (state == undefined || epoch !== this.takeoverEpoch) {
            return;
        }
        const seen = ackTakeover ? this.unseenTakenOverAt : undefined;
        const body = { ...state, seenTakenOverAt: seen ?? null };

        try {
            if (!await ensureDeviceCheckedIn()) {
                throw new Error("the device check-in failed");
            }
            try {
                await this.api.playbackSessionPut(deviceId, body);
            } catch (e) {
                // 404: the server doesn't know this device (its row was removed, or a new server). Check in again and
                // try once more, but only once until a publish works: an API without playback sessions 404s every time.
                if (!(e instanceof ApiStatusFailureError && e.status === 404) || this.forcedCheckIn) {
                    throw e;
                }
                this.forcedCheckIn = true;
                if (!await ensureDeviceCheckedIn(true)) {
                    throw e;
                }
                await this.api.playbackSessionPut(deviceId, body);
            }
            this.lastPublish = { probe, at: Date.now() };
            this.publishFailedAt = undefined;
            this.publishFailures = 0;
            this.forcedCheckIn = false;
            if (ackTakeover) {
                if (this.unseenTakenOverAt === seen) {
                    this.unseenTakenOverAt = undefined;
                }
            } else {
                this.publishPausedState = false;
            }
        } catch (e) {
            this.publishFailedAt = Date.now();
            this.publishFailures++;
            const waitS = backoffMs(this.publishFailures, PUBLISH_RETRY_MIN_MS, PUBLISH_RETRY_MAX_MS) / 1000;
            log.warn("playback-sessions", `could not publish this device's playback; retrying in ${waitS} s`, e);
        }
    }

    // ---- Reading: the live channel, with polling as the fallback ----

    private async connect(deviceId: string): Promise<void> {
        if (this.stopped) {
            return;
        }
        const base = this.api.getBaseURL().replace(/\/+$/, "");
        const connection = new HubConnectionBuilder()
            .withUrl(`${base}/hubs/playback?deviceId=${encodeURIComponent(deviceId)}`, {
                // A WebSocket can't carry the Authorization header, so the token goes in the query string, as the hub expects.
                accessTokenFactory: () => this.api.accessToken(),
                // The API's CORS policy doesn't allow credentials, and none are needed: the token is the credential.
                withCredentials: false,
            })
            // Retry for as long as the session lasts, backing off to 30 s.
            .withAutomaticReconnect({ nextRetryDelayInMilliseconds: ({ previousRetryCount }) => Math.min(30_000, 1_000 * 2 ** previousRetryCount) })
            .configureLogging(signalrLogger)
            .build();
        connection.on("SessionChanged", () => this.scheduleRefresh(REFRESH_DEBOUNCE_MS));
        connection.onreconnecting(() => usePlaybackDevices.setState({ live: false }));
        connection.onreconnected(() => {
            usePlaybackDevices.setState({ live: true });
            this.scheduleRefresh(0);
        });
        connection.onclose(() => {
            usePlaybackDevices.setState({ live: false });
            if (this.connection === connection) {
                this.connection = undefined;
                this.retryConnect(deviceId);
            }
        });
        this.connection = connection;

        try {
            // The hub refuses a device that hasn't checked in.
            if (!await ensureDeviceCheckedIn()) {
                throw new Error("the device check-in failed");
            }
            await connection.start();
            if (this.stopped) {
                await connection.stop();
                return;
            }
            this.connectRetryMs = CONNECT_RETRY_MIN_MS;
            usePlaybackDevices.setState({ live: true });
            this.scheduleRefresh(0);
        } catch (e) {
            // Offline, or an API without the hub yet. Polling carries on meanwhile.
            log.warn("playback-sessions", `live channel unavailable; reading every ${POLL_INTERVAL_MS / 1000} s instead`, e);
            if (this.connection === connection) {
                this.connection = undefined;
                this.retryConnect(deviceId);
            }
        }
    }

    private retryConnect(deviceId: string): void {
        if (this.stopped) {
            return;
        }
        clearTimeout(this.connectTimer);
        const delay = this.connectRetryMs;
        this.connectRetryMs = Math.min(CONNECT_RETRY_MAX_MS, this.connectRetryMs * 2);
        this.connectTimer = setTimeout(() => void this.connect(deviceId), delay);
    }

    scheduleRefresh(delayMs: number): void {
        if (this.stopped) {
            return;
        }
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), delayMs);
    }

    /** Reads every session, one read at a time: a signal during a read reads once more after it. */
    private async refresh(): Promise<void> {
        if (this.refreshing != undefined) {
            this.refreshAgain = true;
            return this.refreshing;
        }
        this.refreshing = (async () => {
            do {
                this.refreshAgain = false;
                let response: PlaybackSessionsResponse | undefined;
                try {
                    response = await this.api.playbackSessionsGet();
                    this.pollFailures = 0;
                    this.pollTicksToSkip = 0;
                } catch (e) {
                    this.pollFailures++;
                    // Counted in ticks of the poll timer, so the wait is exact rather than rounded up to the next tick.
                    this.pollTicksToSkip = backoffMs(this.pollFailures, POLL_INTERVAL_MS, POLL_RETRY_MAX_MS) / POLL_INTERVAL_MS - 1;
                    log.debug("playback-sessions", "could not read the playback sessions", e);
                }
                if (response != undefined) {
                    try {
                        await this.apply(response, Date.now());
                    } catch (e) {
                        log.warn("playback-sessions", "could not act on the playback sessions", e);
                    }
                }
            } while (this.refreshAgain && !this.stopped);
        })();
        try {
            await this.refreshing;
        } finally {
            this.refreshing = undefined;
        }
    }

    private async apply(response: PlaybackSessionsResponse, receivedAt: number): Promise<void> {
        if (this.stopped) {
            return;
        }
        const selfId = this.selfDeviceId;
        usePlaybackDevices.setState({ devices: response.devices.filter(d => d.deviceId !== selfId), receivedAt });
        const own = response.devices.find(d => d.deviceId === selfId)?.session;
        if (!this.leader || selfId == undefined || own == undefined) {
            return;
        }

        const takeover = takeoverAction(own, selfId, this.handledTakenOverAt, response.serverTime);
        if (takeover != undefined && own.takenOverAt != undefined) {
            this.handledTakenOverAt = own.takenOverAt.getTime();
            this.unseenTakenOverAt = own.takenOverAt.toISOString();
            if (takeover === "pause") {
                log.info("playback-sessions", `taken over by ${own.takenOverBy}; pausing`);
                this.takenOver = true;
                this.publishPausedState = true;
                this.takeoverEpoch++;
                this.pausingForTakeover = true;
                try {
                    await MediaManager.pause();
                } finally {
                    this.pausingForTakeover = false;
                }
            }
        }

        const command = pendingCommand(own, new Set(this.handledCommands), response.serverTime);
        if (command != undefined) {
            await this.carryOut(selfId, command);
        }
    }

    private async carryOut(selfId: string, command: KnownPlaybackCommand): Promise<void> {
        this.handledCommands.push(command.commandId);
        if (this.handledCommands.length > HANDLED_COMMANDS_MAX) {
            this.handledCommands.shift();
        }
        log.info("playback-sessions", `remote command: ${command.kind}`);
        try {
            switch (command.kind) {
                case "play": await MediaManager.play(); break;
                case "pause": await MediaManager.pause(); break;
                case "next": await MediaManager.skip(); break;
                case "previous": await MediaManager.previous(); break;
                case "seek": await MediaManager.seekTo(command.seekSeconds ?? 0); break;
            }
        } catch (e) {
            log.warn("playback-sessions", `remote ${command.kind} failed`, e);
        }
        // Acked either way: retrying a command that failed here would fail again. A 409 means a newer one replaced it.
        await this.api.playbackCommandAck(selfId, command.commandId)
            .catch(e => log.debug("playback-sessions", "command ack failed", e));
    }

    // ---- Actions for the UI ----

    async takeOver(sourceDeviceId: string): Promise<void> {
        const selfId = this.selfDeviceId;
        if (selfId == undefined || !this.leader) {
            throw new Error("Shuffull is playing in another tab. Take over from there.");
        }
        if (sourceDeviceId === selfId) {
            throw new Error("That's this device.");
        }
        if (!await ensureDeviceCheckedIn()) {
            throw new Error("Couldn't reach the server.");
        }

        // Read the source fresh and ask the server to pause it BEFORE playing anything here: a takeover the server
        // refuses (the source moved on meanwhile) must not leave this device playing an old position.
        let taken: PlaybackSession | undefined;
        for (let attempt = 0; taken == undefined; attempt++) {
            const source = (await this.api.playbackSessionsGet()).devices.find(d => d.deviceId === sourceDeviceId)?.session;
            if (source?.songId == undefined) {
                throw new Error("That device isn't playing anything.");
            }
            if (await DbQueries.getSong(this.db, source.songId) == undefined) {
                throw new Error("The song playing there isn't on this device yet.");
            }
            try {
                taken = await this.api.playbackTakeover(sourceDeviceId, selfId, source.updatedAt);
            } catch (e) {
                // 409: it published between the read and the takeover. Read it again, once.
                if (!(e instanceof ApiStatusFailureError && e.status === 409) || attempt > 0) {
                    throw e;
                }
            }
        }

        const songId = taken.songId;
        if (songId == undefined) {
            throw new Error("That device isn't playing anything.");
        }
        await MediaManager.adoptPlayback({
            songId,
            // The server paused the source at its estimated position, so the two are the same now.
            positionSeconds: taken.positionSeconds,
            scope: scopeToSongFilters(taken.scope),
            history: taken.history,
            queuedNext: taken.queuedNext,
        });
        this.takenOver = false;
        this.publishPausedState = false;
        this.lastPublish = undefined;
        this.scheduleRefresh(0);
    }

    async sendCommand(deviceId: string, kind: PlaybackCommandKind, seekSeconds?: number): Promise<void> {
        await this.api.playbackCommand(deviceId, generateId(), kind, seekSeconds);
        this.scheduleRefresh(REFRESH_DEBOUNCE_MS);
    }
}

/** The SignalR client's own log lines, through the app's log. Its info lines (every connect) are left out. */
const signalrLogger: ILogger = {
    log(level: LogLevel, message: string) {
        if (level >= LogLevel.Error) {
            log.warn("playback-live", message);
        } else if (level === LogLevel.Warning) {
            log.info("playback-live", message);
        }
    },
};
