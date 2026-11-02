import { SongRequestStatus } from "../enums/SongRequestStatus";
import type { SongRequest } from "../services/api/models";
import type { PlayNextIntent } from "../services/db/models";

// "Request & play next" (ShuffullApp#108): the user asked for a song to play right after the current one, but it isn't
// on this device until its request completes and a sync brings it down. The intent is a row (play_next_intents); after
// each sync the app works out here what to do with each one. Everything here is pure, so it is unit-tested on its own.

/**
 * How long an intent waits for its song. "Play this next" means now: a song that turns up hours later and cuts into
 * whatever is playing then would be a surprise. Past this the intent is dropped with a message; the request carries
 * on, and the song still lands in this week's requests playlist.
 */
export const PLAY_NEXT_WAIT_MS = 2 * 60 * 60_000;
/**
 * How long an intent whose song is already queued is kept. It is cleared when the song plays, but a song paused on for
 * a day shouldn't come back at the front of the queue after a restart. Dropped quietly: the queue still has it.
 */
export const PLAY_NEXT_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * An intent with no request id is one whose create call never answered (the app died, the connection dropped). If the
 * request list still shows no request for the song after this long, the request never reached the server.
 */
export const PLAY_NEXT_UNFILED_MS = 2 * 60_000;
/** A request counts as this tap's when the server last touched it no earlier than this before the tap (clock skew). */
const ADOPT_SLACK_MS = 5 * 60_000;

/** What the intent's request now says, as far as the user's request list (the newest 50) shows it. */
export interface ResolvedIntent {
    intent: PlayNextIntent;
    /** Its request in the list, if the list was read and still holds it. */
    request: SongRequest | undefined;
    songRequestId: string | null;
    songId: string | null;
}

export function resolveIntent(intent: PlayNextIntent, requests: readonly SongRequest[] | null): ResolvedIntent {
    const request = intent.songRequestId != null
        ? requests?.find(r => r.songRequestId === intent.songRequestId)
        // Filed, but the answer never came back: the newest request for the song the server touched since the tap.
        : requests?.find(r => r.externalSongId === intent.externalSongId
            && r.updatedAt.getTime() >= intent.createdAt.getTime() - ADOPT_SLACK_MS);
    const completedSongId = request?.status === SongRequestStatus.Completed ? request.songId : null;
    return {
        intent,
        request,
        songRequestId: intent.songRequestId ?? request?.songRequestId ?? null,
        songId: intent.songId ?? completedSongId,
    };
}

/**
 * - "queue": the song is on this device; put it at the front of the play queue.
 * - "wait": not yet. Checked again after the next sync.
 * - "drop": clear the intent. `message` tells the user why, when they need telling.
 */
export type PlayNextDecision =
    | { kind: "queue"; songId: string }
    | { kind: "wait" }
    | { kind: "drop"; message: string | null };

export interface PlayNextContext {
    /** Whether the user's request list was read. When it wasn't, nothing is concluded from a request being missing. */
    listRead: boolean;
    /** Whether a song is in this device's library. */
    isLocal: (songId: string) => boolean;
    /** The song playing now. */
    current: string | undefined;
    now: number;
}

/**
 * What to do with one intent. Every path ends: the song plays, or the request ends Failed or Cancelled, or the wait
 * runs out. That last rule also covers a request that dropped out of the list (it holds the newest 50) and a song
 * that never arrives, so no intent outlives PLAY_NEXT_WAIT_MS unless its song is already queued.
 */
export function decidePlayNext(resolved: ResolvedIntent, context: PlayNextContext): PlayNextDecision {
    const { intent, request, songRequestId, songId } = resolved;
    const age = context.now - intent.createdAt.getTime();
    const title = `"${intent.title}"`;

    if (songId != null && songId === context.current) {
        return { kind: "drop", message: null }; // it is playing: done
    }
    if (songId != null && context.isLocal(songId)) {
        return age > PLAY_NEXT_MAX_AGE_MS ? { kind: "drop", message: null } : { kind: "queue", songId };
    }
    if (request?.status === SongRequestStatus.Failed) {
        const reason = request.failureReason?.trim();
        return { kind: "drop", message: `${title} won't play next: its request failed${reason ? ` (${reason})` : ""}.` };
    }
    if (request?.status === SongRequestStatus.Cancelled) {
        return { kind: "drop", message: `${title} won't play next: its request was cancelled.` };
    }
    if (request?.status === SongRequestStatus.Completed && request.songId == null) {
        // An answer that doesn't say which song it became, so there is nothing to queue.
        return { kind: "drop", message: `${title} is in your library. Play it from there.` };
    }
    if (age > PLAY_NEXT_WAIT_MS) {
        return { kind: "drop", message: `${title} took too long to arrive, so it won't play next. It will be in this week's requests playlist once it does.` };
    }
    if (songRequestId == null && context.listRead && age > PLAY_NEXT_UNFILED_MS) {
        return { kind: "drop", message: `${title} won't play next: its request didn't reach the server. Request it again.` };
    }
    return { kind: "wait" };
}

/** Whether an intent still needs its request's status from the server: until the request completes, there's no song. */
export function needsRequestStatus(intent: PlayNextIntent): boolean {
    return intent.songId == null;
}

/** One message for everything dropped at once, so several endings don't stack up several alerts. */
export function combineMessages(messages: readonly (string | null)[]): string | null {
    const shown = messages.filter((m): m is string => m != null);
    return shown.length ? shown.join("\n\n") : null;
}

/**
 * The play queue with `songIds` at its front, in order, and nothing else moved. The current song is left out: it is
 * already playing. Returns the same array when nothing changes, so the caller can tell.
 */
export function withPlayNextFirst(queue: readonly string[], songIds: readonly string[], current: string | undefined): readonly string[] {
    const front = songIds.filter((id, i) => id !== current && songIds.indexOf(id) === i);
    const next = [...front, ...queue.filter(id => !front.includes(id))];
    return next.length === queue.length && next.every((id, i) => id === queue[i]) ? queue : next;
}

/** What "Up next" says, for the oldest intent: queued, or still waiting for its song. Null with no intent. */
export function describeUpNext(intents: readonly PlayNextIntent[], queuedSongIds: readonly string[]): string | null {
    const first = intents[0];
    if (first == null) {
        return null;
    }
    const more = intents.length > 1 ? ` (+${intents.length - 1})` : "";
    const queued = first.songId != null && queuedSongIds.includes(first.songId);
    return `${queued ? "Up next" : "Next, once it arrives"}: ${first.title}${more}`;
}
