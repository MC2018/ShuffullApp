import { SongFilters } from "../types/SongFilters";
import type { WhitelistSetting } from "../services/db/types";
import type { PlaybackCommand, PlaybackSession, PlaybackSessionBody } from "../services/api/models";

// Cross-device playback (ShuffullApp#194, epic shuffull-workspace#134). Each install publishes what it is playing as a
// playback session on the API; another device can read it, take it over, or send it a command. Everything that can be
// decided without the player, the database or the network lives here, so it is unit-tested on its own. The wiring is
// services/playback/playbackSessions.ts.

/** The API keeps at most this many history songs, newest last. */
export const HISTORY_MAX = 25;
/** The API keeps at most this many queued songs. */
export const QUEUED_NEXT_MAX = 100;
/** The API refuses a scope longer than this, as JSON. */
export const SCOPE_MAX_CHARS = 8192;
/** While playing, the session is published at least this often, so other devices' estimates don't drift. */
export const PUBLISH_INTERVAL_MS = 10_000;
/** A position this far from where the last publish says it should be is a seek, published at once. */
export const SEEK_TOLERANCE_SECONDS = 2;
/**
 * A command older than this (by the server's clock) is not carried out. The API shows one for 60 s; a "pause" sent
 * nearly a minute ago, found by an app that has only just opened, would stop music the user has since started.
 */
export const COMMAND_MAX_AGE_MS = 15_000;
/** Likewise for a takeover: an old one found at startup is marked seen without pausing anything. */
export const TAKEOVER_MAX_AGE_MS = 60_000;

/** One `recently_played_songs` row, as much of it as the session needs. */
export interface HistoryRow {
    songId: string;
    timestampSeconds: number | null;
    lastPlayed: Date;
}

/** What this device is doing, read from the player, the song filters, the history rows and the queue. */
export interface PlayerSnapshot {
    songId: string | undefined;
    positionSeconds: number;
    isPlaying: boolean;
    scope: Record<string, unknown>;
    recentlyPlayed: readonly HistoryRow[];
    queue: readonly string[];
}

/** The session this device publishes, without the takeover acknowledgement the publisher adds. */
export type PublishedState = Omit<PlaybackSessionBody, "seenTakenOverAt">;

/**
 * The session to publish for `snapshot`, or undefined when nothing is loaded.
 *
 * History is every row played before the current one, oldest first, the last HISTORY_MAX of them: what Previous walks
 * on the device that takes over. Rows after the current one exist after a Previous, and skip() plays them once the
 * queue is empty, so they follow the queue in `queuedNext`.
 */
export function buildPublishedState(snapshot: PlayerSnapshot): PublishedState | undefined {
    const { songId } = snapshot;
    if (songId == undefined) {
        return undefined;
    }

    const rows = [...snapshot.recentlyPlayed].sort((a, b) => a.lastPlayed.getTime() - b.lastPlayed.getTime());
    const current = currentRow(rows, songId);
    const before = current == undefined
        ? rows.filter((row, i) => !(i === rows.length - 1 && row.songId === songId))
        : rows.filter(row => row.lastPlayed.getTime() < current.lastPlayed.getTime());
    const after = current == undefined ? [] : rows.filter(row => row.lastPlayed.getTime() > current.lastPlayed.getTime());

    return {
        songId,
        positionSeconds: cleanPosition(snapshot.positionSeconds),
        isPlaying: snapshot.isPlaying,
        scope: boundedScope(snapshot.scope),
        history: before.map(row => row.songId).slice(-HISTORY_MAX),
        queuedNext: [...snapshot.queue, ...after.map(row => row.songId)].slice(0, QUEUED_NEXT_MAX),
    };
}

/**
 * The row for the song playing now. Like getCurrentlyPlayingSong: the newest row still carrying a position. Failing
 * that (the marker is cleared for a moment during a track change), the newest row for the song.
 */
function currentRow(sortedRows: readonly HistoryRow[], songId: string): HistoryRow | undefined {
    for (let i = sortedRows.length - 1; i >= 0; i--) {
        if (sortedRows[i].timestampSeconds != null) {
            return sortedRows[i];
        }
    }
    for (let i = sortedRows.length - 1; i >= 0; i--) {
        if (sortedRows[i].songId === songId) {
            return sortedRows[i];
        }
    }
    return undefined;
}

/** The API refuses a negative or non-finite position. Milliseconds are as precise as anything else on the wire. */
function cleanPosition(seconds: number): number {
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : 0;
}

/** A scope too long for the API is sent empty, so the rest of the session still publishes: shuffle everything. */
function boundedScope(scope: Record<string, unknown>): Record<string, unknown> {
    return JSON.stringify(scope).length <= SCOPE_MAX_CHARS ? scope : {};
}

/** The cheap part of the state, read every second to decide whether to build and send the rest. */
export interface PublishProbe {
    songId: string | undefined;
    isPlaying: boolean;
    positionSeconds: number;
    /** Bumped by every change to the scope, the queue or the history that the probe can't see otherwise. */
    revision: number;
}

export interface LastPublish {
    probe: PublishProbe;
    /** Local clock, ms. */
    at: number;
}

/**
 * Whether to publish now: a track change, play or pause, a scope, queue or history change, a seek, or PUBLISH_INTERVAL_MS
 * since the last publish while playing. Nothing is published with no song loaded, and a paused song that hasn't moved
 * isn't sent again.
 */
export function needsPublish(last: LastPublish | undefined, probe: PublishProbe, now: number): boolean {
    if (probe.songId == undefined) {
        return false;
    }
    if (last == undefined) {
        return true;
    }
    const before = last.probe;
    if (before.songId !== probe.songId || before.isPlaying !== probe.isPlaying || before.revision !== probe.revision) {
        return true;
    }
    const expected = before.positionSeconds + (before.isPlaying ? (now - last.at) / 1000 : 0);
    if (Math.abs(probe.positionSeconds - expected) > SEEK_TOLERANCE_SECONDS) {
        return true;
    }
    return probe.isPlaying && now - last.at >= PUBLISH_INTERVAL_MS;
}

/**
 * Where a session's song is now. The API estimates it as of `serverTime`; this carries it on by the local time since
 * that answer arrived (`receivedAt`, local clock), so the two clocks never have to agree.
 */
export function estimatePosition(session: Pick<PlaybackSession, "estimatedPositionSeconds" | "isPlaying">,
    receivedAt: number, now: number): number {
    const elapsed = session.isPlaying ? Math.max(0, now - receivedAt) / 1000 : 0;
    return session.estimatedPositionSeconds + elapsed;
}

/** A history row to write when taking over, without its id (the caller makes those). */
export interface RebuiltRow {
    songId: string;
    timestampSeconds: number | null;
    lastPlayed: Date;
}

/**
 * The `recently_played_songs` rows that make this device continue `session`: its history in order, then its song as
 * the current row at `positionSeconds`, newest. Songs this device doesn't have are left out, since Previous would
 * fail on them. Each row is a second apart, ending at `now`, so their order survives any timestamp precision.
 */
export function rebuildHistory(session: { songId: string; history: readonly string[] }, positionSeconds: number, now: number,
    isKnown: (songId: string) => boolean): RebuiltRow[] {
    const history = session.history.filter(isKnown).slice(-HISTORY_MAX);
    const rows: RebuiltRow[] = history.map((songId, i) => ({
        songId,
        timestampSeconds: null,
        lastPlayed: new Date(now - (history.length - i) * 1000),
    }));
    rows.push({ songId: session.songId, timestampSeconds: cleanPosition(positionSeconds), lastPlayed: new Date(now) });
    return rows;
}

/** The scope a session carries, as this app's song filters. Anything the filters don't know, or of the wrong type, is dropped. */
export function scopeToSongFilters(scope: Record<string, unknown>): SongFilters {
    const filters = new SongFilters();
    filters.localOnly = scope.localOnly === true;
    filters.unheardOnly = scope.unheardOnly === true;
    filters.genreJam = scope.genreJam === true;
    filters.heavinessMin = heaviness(scope.heavinessMin);
    filters.heavinessMax = heaviness(scope.heavinessMax);
    filters.whitelists = whitelist(scope.whitelists, filters.whitelists);
    filters.blacklists = whitelist(scope.blacklists, filters.blacklists);
    return filters;
}

/** The song filters as the JSON object a session carries: the same shape they are saved in. */
export function songFiltersToScope(filters: SongFilters): Record<string, unknown> {
    return JSON.parse(JSON.stringify(filters)) as Record<string, unknown>;
}

function heaviness(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function whitelist(value: unknown, empty: WhitelistSetting): WhitelistSetting {
    if (value == null || typeof value !== "object") {
        return empty;
    }
    const source = value as Record<string, unknown>;
    const ids = (key: keyof WhitelistSetting) => {
        const list = source[key];
        return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
    };
    return {
        artistIds: ids("artistIds"),
        playlistIds: ids("playlistIds"),
        genreIds: ids("genreIds"),
        timePeriodIds: ids("timePeriodIds"),
        languageIds: ids("languageIds"),
        moodIds: ids("moodIds"),
        themeIds: ids("themeIds"),
    };
}

/**
 * Whether this device has just been taken over: its session says another device took it, and this device hasn't acted
 * on that takeover yet (`handledAt`, the takenOverAt it last acted on, in ms). An old one (TAKEOVER_MAX_AGE_MS by the
 * server's clock) is "stale": mark it seen without pausing.
 */
export function takeoverAction(session: Pick<PlaybackSession, "takenOverBy" | "takenOverAt"> | null | undefined,
    selfDeviceId: string, handledAt: number | undefined, serverTime: Date): "pause" | "stale" | undefined {
    if (session?.takenOverBy == undefined || session.takenOverAt == undefined || session.takenOverBy === selfDeviceId) {
        return undefined;
    }
    const at = session.takenOverAt.getTime();
    if (at === handledAt) {
        return undefined;
    }
    return serverTime.getTime() - at <= TAKEOVER_MAX_AGE_MS ? "pause" : "stale";
}

/**
 * The command to carry out from this device's session: one not handled yet (`handled` holds the ids already done) and
 * no older than COMMAND_MAX_AGE_MS by the server's clock. A seek without a position is dropped.
 */
export function pendingCommand(session: Pick<PlaybackSession, "command"> | null | undefined,
    handled: ReadonlySet<string>, serverTime: Date): PlaybackCommand | undefined {
    const command = session?.command;
    if (command == undefined || handled.has(command.commandId)) {
        return undefined;
    }
    if (serverTime.getTime() - command.at.getTime() > COMMAND_MAX_AGE_MS) {
        return undefined;
    }
    if (command.kind === "seek" && (command.seekSeconds == undefined || !Number.isFinite(command.seekSeconds))) {
        return undefined;
    }
    return command;
}
