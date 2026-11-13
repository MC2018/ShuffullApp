import { create } from "zustand";
import type { ApiClient } from "../api/ApiClient";
import { SongRequest, SongRequestSearchResult } from "../api/models";
import { GenericDb } from "../db/GenericDb";
import { PlayNextIntent } from "../db/models";
import DbQueries from "../db/queries";
import { MediaManager } from "../media-manager";
import { useActiveSong } from "../media-manager/mediaManager";
import { SongRequestStatus } from "../../enums/SongRequestStatus";
import { createSerialLock } from "../../tools/serialLock";
import { showAlert } from "../../tools/dialog";
import { combineMessages, decidePlayNext, needsRequestStatus, resolveIntent } from "../../tools/playNext";
import { playWhenSynced, PlayWhenSyncedOutcome } from "./playRequested";
import { currentSongRequests, refreshSongRequests } from "./useSongRequests";
import { log } from "../../tools/log";

// "Request & play next" (ShuffullApp#108). The tap writes a play_next_intents row before anything else. After every
// sync, reconcilePlayNext reads the user's request list (the same one the requests screen shows) while an intent is
// still waiting for its song, and once the song is on this device puts it at the front of the play queue. The row is
// what lasts: the queue is in memory, so a restart or a new scope empties it, and the next sync puts the song back.
// The row goes once the song starts playing, or when tools/playNext.ts says it is over.
//
// "Play next" on a song already in the library (ShuffullApp#25) uses the same rows: playLibrarySongNext saves one with
// the song id known, so the reconcile it runs queues the song at once.

interface PlayNextState {
    /** Oldest first. */
    intents: PlayNextIntent[];
    /** The intents' songs this device has queued. */
    queuedSongIds: string[];
}

export const usePlayNext = create<PlayNextState>(() => ({ intents: [], queuedSongIds: [] }));

interface Session {
    db: GenericDb;
    api: ApiClient;
    userId: string;
}

let session: Session | null = null;
// One reconcile or intent change at a time, so two can't both act on the same row (and both tell the user).
const lock = createSerialLock({ name: "play-next" });

async function reload(s: Session): Promise<PlayNextIntent[]> {
    const intents = await DbQueries.getPlayNextIntents(s.db, s.userId);
    if (session === s) {
        const songIds = new Set(intents.map(i => i.songId));
        usePlayNext.setState({ intents, queuedSongIds: usePlayNext.getState().queuedSongIds.filter(id => songIds.has(id)) });
    }
    return intents;
}

/**
 * Starts play-next for a signed-in session: shows its intents, clears each one once its song starts playing, and
 * reconciles at once, so a song already on the device is queued again after a restart. Returns the stop function.
 */
export function startPlayNext(db: GenericDb, api: ApiClient, userId: string): () => void {
    const s: Session = { db, api, userId };
    session = s;
    usePlayNext.setState({ intents: [], queuedSongIds: [] });
    const unsubscribe = useActiveSong.subscribe((state, previous) => {
        if (state.songId == null || state.songId === previous.songId) {
            return;
        }
        const songId = state.songId;
        const { intents } = usePlayNext.getState();
        if (intents.some(i => i.songId === songId)) {
            void lock.run(() => dropIntentsForSong(s, songId)).catch(e => log.warn("play-next", "clearing a played intent failed", e));
        }
        if (usePlayNext.getState().queuedSongIds.some(id => id !== songId)) {
            // Tapping a song in a playlist, or starting a genre jam, is a new scope, and a new scope empties the queue.
            // Put the other queued play-next songs back now (ShuffullApp#25) rather than at the next sync, which would
            // let a shuffle pick play first. Only while this device has queued one, so a track change with nothing
            // queued runs no reconcile. Runs after dropIntentsForSong (one lock), and queueNext is idempotent. Like any
            // reconcile, it can also drop an intent that has run out of time and say so, as the next sync would.
            void reconcilePlayNext({ readRequests: false });
        }
    });
    void reconcilePlayNext({ readRequests: false });
    return () => {
        unsubscribe();
        if (session === s) {
            session = null;
            usePlayNext.setState({ intents: [], queuedSongIds: [] });
        }
    };
}

// Drops every intent for the song, once it starts playing or the user takes it off (cancelPlayNextForSong). Also takes
// the song off the queue: a reconcile that ran between skip taking it off the queue and the song starting
// (loading a track takes a moment) will have put it back, and it would play again straight after itself.
async function dropIntentsForSong(s: Session, songId: string): Promise<void> {
    for (const intent of await DbQueries.getPlayNextIntents(s.db, s.userId)) {
        if (intent.songId === songId) {
            await DbQueries.deletePlayNextIntent(s.db, intent);
        }
    }
    MediaManager.unqueue(songId);
    await reload(s);
}

/**
 * Works through every intent: learns its request id and song, queues the song once it is on this device, and drops
 * what is over, telling the user why. `readRequests` re-reads the request list first when an intent still waits on
 * its request; the sync passes it, so the list is read at most once per sync, and only while there is something to
 * learn from it.
 */
export function reconcilePlayNext({ readRequests }: { readRequests: boolean }): Promise<void> {
    const s = session;
    if (s == null) {
        return Promise.resolve();
    }
    return lock.run(() => reconcile(s, readRequests)).catch(e => log.warn("play-next", "reconcile failed", e));
}

async function reconcile(s: Session, readRequests: boolean): Promise<void> {
    const intents = await reload(s);
    if (intents.length === 0) {
        return;
    }
    if (readRequests && intents.some(needsRequestStatus)) {
        await refreshSongRequests(s.api);
    }
    const requests = currentSongRequests(s.api);

    const resolved = intents.map(intent => resolveIntent(intent, requests));
    const local = new Set<string>();
    for (const { songId } of resolved) {
        if (songId != null && await DbQueries.getSong(s.db, songId)) {
            local.add(songId);
        }
    }
    const context = { listRead: requests != null, isLocal: (id: string) => local.has(id), current: useActiveSong.getState().songId, now: Date.now() };

    const toQueue: string[] = [];
    const messages: (string | null)[] = [];
    for (const item of resolved) {
        const decision = decidePlayNext(item, context);
        if (decision.kind === "drop") {
            await DbQueries.deletePlayNextIntent(s.db, item.intent);
            messages.push(decision.message);
            continue;
        }
        if (item.songRequestId !== item.intent.songRequestId || item.songId !== item.intent.songId) {
            await DbQueries.updatePlayNextIntent(s.db, item.intent, { songRequestId: item.songRequestId, songId: item.songId });
        }
        if (decision.kind === "queue") {
            toQueue.push(decision.songId);
        }
    }
    if (session !== s) {
        return;
    }
    MediaManager.queueNext(toQueue);
    usePlayNext.setState({ queuedSongIds: toQueue });
    await reload(s);

    const message = combineMessages(messages);
    if (message) {
        showAlert("Not playing next", message);
    }
}

/**
 * A song an intent can name at the tap, so it waits on no request: one the user has (Shuffull#117, no request at all),
 * or one whose request already completed.
 */
export type KnownPlayNextSong = { songId: string; songRequestId: string | null };

/** What an intent row needs to name its song: the key it is stored under, and what "Up next" calls it. */
export type PlayNextSong = Pick<PlayNextIntent, "externalSongId" | "title">;

/**
 * The tap on "Request & play next". Writes the intent and nothing else, so it is saved before the request is filed:
 * the caller files (or reuses) the request, then passes it to attachPlayNextRequest, or calls cancelPlayNext when
 * filing failed. With `known` there is nothing to file; savePlayNext is the one call for that case.
 */
export function recordPlayNext(result: PlayNextSong, known?: KnownPlayNextSong): Promise<void> {
    const s = session;
    if (s == null) {
        return Promise.reject(new Error("Not signed in."));
    }
    return lock.run(async () => {
        // The library and the request search key their rows their own way, so asking for one song from both would
        // otherwise leave two rows: "Up next" would count it twice, and taking one off would leave the other. Asking
        // again still starts the wait over, as a second tap on the same row does (savePlayNextIntent).
        const songId = known?.songId;
        const existing = songId == null ? undefined
            : (await DbQueries.getPlayNextIntents(s.db, s.userId)).find(i => i.songId === songId);
        if (existing) {
            await DbQueries.savePlayNextIntent(s.db, { ...existing, createdAt: new Date() });
            await reload(s);
            return;
        }
        await DbQueries.savePlayNextIntent(s.db, {
            userId: s.userId,
            externalSongId: result.externalSongId,
            songRequestId: known?.songRequestId ?? null,
            title: result.title,
            songId: known?.songId ?? null,
            createdAt: new Date(),
        });
        await reload(s);
    });
}

/**
 * Saves the intent for a song that needs no request, then reconciles, so it is queued at once if this device has it.
 * Returns why it couldn't be saved, or null.
 */
export async function savePlayNext(result: PlayNextSong, known: KnownPlayNextSong): Promise<string | null> {
    try {
        await recordPlayNext(result, known);
    } catch (error) {
        return String(error);
    }
    await reconcilePlayNext({ readRequests: false });
    return null;
}

/**
 * "Play it now" for a song the server has linked to the user (Shuffull#117). If this device doesn't have it yet, the
 * intent is saved before the wait, so the ask outlives the wait, the screen and the app: the song plays when it arrives
 * if nothing else started meanwhile, and right after the current song otherwise. `queued` says that intent was saved.
 */
export async function playNowOrNext(
    db: GenericDb,
    result: SongRequestSearchResult,
    known: KnownPlayNextSong,
    signal: AbortSignal,
): Promise<{ outcome: PlayWhenSyncedOutcome; queued: boolean }> {
    let queued = false;
    const onDevice = (await DbQueries.getSong(db, known.songId)) != null;
    if (!onDevice) {
        const error = await savePlayNext(result, known);
        if (error != null) {
            log.warn("play-next", "couldn't save the intent for a play-now", error);
        }
        queued = error == null;
    }
    return { outcome: await playWhenSynced(db, known.songId, signal), queued };
}

/** The request the intent waits on, once filed or found. Queues the song at once if it is already on this device. */
export async function attachPlayNextRequest(request: SongRequest): Promise<void> {
    const s = session;
    if (s == null) {
        return;
    }
    await lock.run(async () => {
        const intent = (await DbQueries.getPlayNextIntents(s.db, s.userId)).find(i => i.externalSongId === request.externalSongId);
        if (intent) {
            await DbQueries.updatePlayNextIntent(s.db, intent, {
                songRequestId: request.songRequestId,
                songId: request.status === SongRequestStatus.Completed ? request.songId : null,
            });
        }
    });
    await reconcilePlayNext({ readRequests: false });
}

/**
 * The play_next_intents key for a song picked from the library (ShuffullApp#25). The table is keyed by the song's
 * source id because a requested song has no song id until its request completes. A library song always has a song id
 * and may have no source id at all (a manual upload), so its row is keyed by the song id instead. No source id
 * starts with "library:", so the two kinds can't collide.
 */
export function libraryPlayNextKey(songId: string): string {
    return `library:${songId}`;
}

/**
 * "Play next" on a song in the library (ShuffullApp#25). The song is on this device, so the reconcile savePlayNext runs
 * queues it straight away, right after the current song and behind any play-next asked for earlier. Like any intent it
 * lasts until the song plays, a restart included. Returns why it couldn't be saved, or null.
 */
export async function playLibrarySongNext(song: { songId: string; name: string }): Promise<string | null> {
    if (useActiveSong.getState().songId === song.songId) {
        return "It's playing now.";
    }
    return await savePlayNext({ externalSongId: libraryPlayNextKey(song.songId), title: song.name }, { songId: song.songId, songRequestId: null });
}

/**
 * Takes a song off play-next, whichever screen asked for it. recordPlayNext keeps one row per known song, but a
 * request row only learns its song later, so one song can still have a row from each screen. This drops every row
 * that names it.
 */
export async function cancelPlayNextForSong(songId: string): Promise<void> {
    const s = session;
    if (s == null) {
        return;
    }
    await lock.run(() => dropIntentsForSong(s, songId));
}

/** Drops the intent for a song: filing its request failed, or the user changed their mind. */
export async function cancelPlayNext(externalSongId: string): Promise<void> {
    const s = session;
    if (s == null) {
        return;
    }
    await lock.run(async () => {
        const intent = (await DbQueries.getPlayNextIntents(s.db, s.userId)).find(i => i.externalSongId === externalSongId);
        if (intent) {
            await DbQueries.deletePlayNextIntent(s.db, intent);
            if (intent.songId != null) {
                MediaManager.unqueue(intent.songId);
            }
        }
        await reload(s);
    });
}
