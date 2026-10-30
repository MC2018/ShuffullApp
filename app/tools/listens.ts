import type { ListenContext, ListenEndReason, listenTable, RecordListenPayload } from "@/app/services/db/schema";

// The pure parts of recording a listen (ShuffullApp#57): the clock that counts playback seconds, the context a song
// was played in, and the wire item a finished listen becomes. listenRecorder.ts drives them from the player.

/**
 * Counts the seconds a song actually played. It runs only while the player reports State.Playing, so pauses,
 * buffering, loading and a seek's rebuffer don't count, and a seek forward adds only the time it really played.
 */
export interface ListenClock {
    /** Playback seconds banked before `playingSince`. */
    seconds: number;
    /** When the current stretch of playback began (epoch ms), or null while not playing. */
    playingSince: number | null;
}

export function newListenClock(playing: boolean, now: number): ListenClock {
    return { seconds: 0, playingSince: playing ? now : null };
}

/** The seconds played up to `now`. A clock that stepped backwards adds nothing rather than taking seconds away. */
export function clockSeconds(clock: ListenClock, now: number): number {
    return clock.seconds + (clock.playingSince == null ? 0 : Math.max(0, now - clock.playingSince) / 1000);
}

/** The clock after the player reports playing (true) or anything else (false) at `now`. */
export function clockAt(clock: ListenClock, playing: boolean, now: number): ListenClock {
    if (playing) {
        return clock.playingSince == null ? { seconds: clock.seconds, playingSince: now } : clock;
    }

    return clock.playingSince == null ? clock : { seconds: clockSeconds(clock, now), playingSince: null };
}

/** The song playing when a fresh JS context starts, as the player reports it. */
export interface PlayingTrack {
    songId: string;
    /** The player's position in the track, in seconds. */
    positionSeconds: number;
}

/**
 * How far past the time since the orphan's checkpoint the player's position must be before the play counts as the
 * same one. Covers the player's clock and the device's drifting apart; it only ever makes a takeover rarer.
 */
export const TAKE_OVER_MARGIN_SECONDS = 1;

/**
 * Which listen a previous JS context left open is the play still going on now, if one is (ShuffullApp#147). The new
 * context then carries on that listen instead of closing it and opening another partway through the song.
 *
 * It has to be the playing song, and the song must not have started over since the listen's last checkpoint (repeat,
 * or the queue coming back round to it while no JS ran). A play that began after the checkpoint has been going for at
 * most the time since then, so it is at a position no further than that. A position past it means the song has played
 * straight through since the checkpoint, and this is the same play. Nearer the start it can't be told apart from a new
 * play, so nothing is taken over and the caller closes the orphan and opens a new listen, as before.
 *
 * Of several for the song, the newest checkpoint is the play; the others are older plays and get closed.
 */
export function listenToTakeOver<T extends { songId: string; checkpointedAt: Date }>(
    orphans: readonly T[],
    playing: PlayingTrack,
    nowMs: number,
): T | undefined {
    const newest = orphans
        .filter(x => x.songId === playing.songId)
        .reduce<T | undefined>((a, b) => (a == undefined || b.checkpointedAt.getTime() > a.checkpointedAt.getTime() ? b : a), undefined);
    if (newest == undefined || !Number.isFinite(playing.positionSeconds)) {
        return undefined;
    }

    const sinceCheckpointSeconds = (nowMs - newest.checkpointedAt.getTime()) / 1000;
    return playing.positionSeconds > sinceCheckpointSeconds + TAKE_OVER_MARGIN_SECONDS ? newest : undefined;
}

/** What decides a listen's context, read when the song starts. */
export interface ListenContextInput {
    /** The song is still an un-vetted audition song (`songs.exploratory`). */
    songExploratory: boolean;
    /** The play scope is an audition (`SongFilters.unheardOnly`, set only by the audition play paths). */
    unheardOnly: boolean;
    /** The play scope came from a genre jam (`SongFilters.genreJam`). */
    genreJam: boolean;
    /** The play scope's whitelisted playlists. */
    playlistIds: string[];
    /** The scope's playlist, when it has exactly one, is an audition playlist (`playlists.is_exploratory`). */
    scopePlaylistExploratory: boolean;
    /** A caller that knows better, e.g. audition mode (ShuffullApp#125). "audition" always wins. */
    override?: ListenContext;
}

/**
 * The listen's context and playlist. Audition when the song is still exploratory or was played from an audition
 * scope, then genre jam, then playlist when the scope is one playlist, else other. The playlist id is recorded
 * whenever the scope is exactly one playlist.
 */
export function listenContext(input: ListenContextInput): { context: ListenContext; playlistId: string | null } {
    const playlistId = input.playlistIds.length === 1 ? input.playlistIds[0] : null;

    if (input.override === "audition" || input.songExploratory || input.unheardOnly || input.scopePlaylistExploratory) {
        return { context: "audition", playlistId };
    }
    if (input.override != undefined) {
        return { context: input.override, playlistId };
    }
    if (input.genreJam) {
        return { context: "genreJam", playlistId };
    }

    return { context: playlistId != null ? "playlist" : "other", playlistId };
}

/** `Platform.OS`, except the Electron app, which runs the web build and says "desktop". */
export function listenPlatform(os: string, desktop: boolean): string {
    return desktop ? "desktop" : os;
}

/** An open listen as the payload builder needs it: a `listens` row, less the progress fields the builder is given. */
export type OpenListenFields = Omit<typeof listenTable.$inferSelect, "secondsListened" | "checkpointedAt">;

/**
 * The wire item for a listen that ended at `endedAtMs` with `secondsListened` played.
 *
 * The server rejects a listen whose seconds exceed its wall-clock span (plus 5 s) or that ends before it starts. Both
 * come from the same device clock here, so the span is moved out to cover the seconds if the clock stepped back
 * mid-song, rather than losing the listen or its seconds.
 */
export function finishedListen(
    open: OpenListenFields,
    endedAtMs: number,
    secondsListened: number,
    endReason: ListenEndReason,
): RecordListenPayload {
    const seconds = Math.round(Math.max(0, Number.isFinite(secondsListened) ? secondsListened : 0) * 1000) / 1000;
    const startedAtMs = open.startedAt.getTime();
    const endedAt = Math.max(endedAtMs, startedAtMs + Math.ceil(seconds * 1000));
    const duration = open.songDurationSeconds;

    return {
        listenId: open.listenId,
        songId: open.songId,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        secondsListened: seconds,
        songDurationSeconds: duration != null && Number.isFinite(duration) && duration > 0 ? duration : null,
        endReason,
        context: open.context,
        playlistId: open.playlistId,
        platform: open.platform,
        userId: open.userId,
    };
}
