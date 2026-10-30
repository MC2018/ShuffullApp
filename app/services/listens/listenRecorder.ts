import { GenericDb } from "../db/GenericDb";
import { ListenContext, ListenEndReason, OpenListen } from "../db/models";
import { closeListen, getOpenListens, saveOpenListen } from "../db/queries/listen";
import { createSerialLock } from "@/app/tools/serialLock";
import { generateId } from "@/app/tools/pure";
import { clockAt, clockSeconds, finishedListen, ListenClock, newListenClock } from "@/app/tools/listens";

/** How often an open listen is checkpointed while it plays. A kill mid-song loses at most this much of it. */
export const LISTEN_CHECKPOINT_INTERVAL_MS = 10_000;

/** A listen starting: the song, who is listening, and where it was played from. */
export interface ListenStart {
    songId: string;
    userId: string;
    context: ListenContext;
    playlistId: string | null;
    platform: string | null;
    /** Whether the song is already playing. A listen opened as a song is loaded starts paused: it isn't yet. */
    playing?: boolean;
}

export interface ListenRecorderDeps {
    now?: () => number;
    /**
     * The duration in seconds of `songId`'s track, or anything not above 0 when unknown. Unknown unless that song is
     * the loaded track: a listen opens before its track loads, and the previous song's duration must not stick to it.
     */
    trackDuration?: (songId: string) => Promise<number | undefined>;
    checkpointIntervalMs?: number;
}

interface CurrentListen {
    row: OpenListen;
    clock: ListenClock;
    /** Playback failed since this song last played (playbackFailed). */
    failed: boolean;
}

/**
 * Records one listen per play (ShuffullApp#57). The player calls in at each track change and playback state change;
 * this owns everything else, so the player's own behaviour never depends on it. Every method catches its own errors.
 *
 * A listen is open from its song starting until the next track change. While open it lives in memory, checkpointed to
 * the `listens` table as it plays. Closing it moves it, finished, into the outbox (closeListen), which syncs it to
 * POST /api/v1/listens. A row left open by a run that died is closed as "stopped" at its last checkpoint by recover().
 *
 * The DB work runs one call at a time in call order, so a checkpoint queued before a close can't land after it and
 * reopen the listen. The clock itself moves at once, when the player reports, so its seconds don't wait on the DB.
 */
export class ListenRecorder {
    private db: GenericDb | undefined;
    private current: CurrentListen | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private readonly lock = createSerialLock({ name: "listens" });
    private readonly now: () => number;
    private readonly trackDuration: (songId: string) => Promise<number | undefined>;
    private readonly checkpointIntervalMs: number;

    constructor(deps: ListenRecorderDeps = {}) {
        this.now = deps.now ?? Date.now;
        this.trackDuration = deps.trackDuration ?? (async () => undefined);
        this.checkpointIntervalMs = deps.checkpointIntervalMs ?? LISTEN_CHECKPOINT_INTERVAL_MS;
    }

    attach(db: GenericDb): void {
        this.db = db;
    }

    /** The song of the open listen, if one is open. */
    get openSongId(): string | undefined {
        return this.current?.row.songId;
    }

    /** Closes listens a previous run left open as "stopped", with the seconds and time of their last checkpoint. */
    recover(): Promise<void> {
        return this.guarded("recover", async db => {
            const orphans = (await getOpenListens(db)).filter(x => x.listenId !== this.current?.row.listenId);
            for (const orphan of orphans) {
                await closeListen(db, finishedListen(orphan, orphan.checkpointedAt.getTime(), orphan.secondsListened, "stopped"));
            }
            if (orphans.length) {
                console.info(`[listens] closed ${orphans.length} listen(s) left open by the last run as stopped.`);
            }
        });
    }

    /** Opens a listen for a song starting. One still open is closed first, as "stopped". */
    async begin(start: ListenStart): Promise<void> {
        // The new listen is in memory before this awaits anything, so a state change reported meanwhile reaches it.
        // The DB queue still runs the old one's close before the new one's first checkpoint.
        const closing = this.end("stopped");

        const now = this.now();
        this.current = {
            row: {
                listenId: generateId(),
                userId: start.userId,
                songId: start.songId,
                startedAt: new Date(now),
                secondsListened: 0,
                songDurationSeconds: null,
                context: start.context,
                playlistId: start.playlistId,
                platform: start.platform,
                checkpointedAt: new Date(now),
            },
            clock: newListenClock(start.playing ?? false, now),
            failed: false,
        };
        this.syncTimer();
        await Promise.all([closing, this.checkpoint()]);
    }

    /**
     * Closes the open listen, if any, for `reason`. Call it before the track it was for is unloaded.
     *
     * A song that failed to play and hasn't played since closes as "stopped" whatever the reason: moving off a song
     * that couldn't load isn't a skip, and the server's maybe-drop rule counts quick skips.
     */
    async end(reason: ListenEndReason): Promise<void> {
        const current = this.current;
        if (current == undefined) {
            return;
        }
        const endReason = current.failed && reason !== "finished" ? "stopped" : reason;

        // Taken now, not when the queue gets to it: the listen ends when the player says so.
        const endedAt = this.now();
        const seconds = clockSeconds(current.clock, endedAt);
        this.current = undefined;
        this.syncTimer();

        await this.guarded("close", async db => {
            const row = { ...current.row, songDurationSeconds: current.row.songDurationSeconds ?? await this.knownDuration(current.row.songId) };
            await closeListen(db, finishedListen(row, endedAt, seconds, endReason));
        });
    }

    /** The player reported playing (true) or any other state (false): paused, buffering, loading, ended, an error. */
    playbackStateChanged(playing: boolean): Promise<void> {
        const current = this.current;
        if (current == undefined) {
            return Promise.resolve();
        }
        if (playing) {
            current.failed = false; // it plays again: a skip from here on is the user's
        }

        const next = clockAt(current.clock, playing, this.now());
        if (next === current.clock) {
            return Promise.resolve();
        }

        current.clock = next;
        this.syncTimer();
        return this.checkpoint();
    }

    /** The player couldn't play `songId` (a load error, a stall, offline). Marks its listen, if it is the open one. */
    playbackFailed(songId: string): void {
        if (this.current?.row.songId === songId) {
            this.current.failed = true;
        }
    }

    /** Saves the open listen's seconds so far, so a kill from here on loses nothing before now. */
    checkpoint(): Promise<void> {
        return this.guarded("checkpoint", async db => {
            const current = this.current;
            if (current == undefined) {
                return; // closed while this waited its turn
            }

            const now = this.now();
            current.row = {
                ...current.row,
                secondsListened: clockSeconds(current.clock, now),
                songDurationSeconds: current.row.songDurationSeconds ?? await this.knownDuration(current.row.songId),
                checkpointedAt: new Date(now),
            };
            await saveOpenListen(db, current.row);
        });
    }

    // Checkpoints on a timer only while something is playing: paused, the last checkpoint already holds it all.
    private syncTimer() {
        const shouldRun = this.current?.clock.playingSince != null;
        if (shouldRun && this.timer == undefined) {
            this.timer = setInterval(() => void this.checkpoint(), this.checkpointIntervalMs);
        } else if (!shouldRun && this.timer != undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private async knownDuration(songId: string): Promise<number | null> {
        try {
            const duration = await this.trackDuration(songId);
            return duration != undefined && Number.isFinite(duration) && duration > 0 ? duration : null;
        } catch {
            return null;
        }
    }

    private guarded(what: string, work: (db: GenericDb) => Promise<void>): Promise<void> {
        return this.lock.run(async () => {
            const db = this.db;
            if (db == undefined) {
                return;
            }
            try {
                await work(db);
            } catch (e) {
                console.warn(`[listens] ${what} failed`, e);
            }
        });
    }
}
