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
import { currentSongRequests, refreshSongRequests } from "./useSongRequests";

// "Request & play next" (ShuffullApp#108). The tap writes a play_next_intents row before anything else. After every
// sync, reconcilePlayNext reads the user's request list (the same one the requests screen shows) while an intent is
// still waiting for its song, and once the song is on this device puts it at the front of the play queue. The row is
// what lasts: the queue is in memory, so a restart or a new scope empties it, and the next sync puts the song back.
// The row goes once the song starts playing, or when tools/playNext.ts says it is over.

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
        if (state.songId != null && state.songId !== previous.songId
            && usePlayNext.getState().intents.some(i => i.songId === state.songId)) {
            void lock.run(() => clearPlayed(s, state.songId!)).catch(e => console.warn("[play-next] clearing a played intent failed", e));
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

// Also takes the song off the queue: a reconcile that ran between skip taking it off the queue and the song starting
// (loading a track takes a moment) will have put it back, and it would play again straight after itself.
async function clearPlayed(s: Session, songId: string): Promise<void> {
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
    return lock.run(() => reconcile(s, readRequests)).catch(e => console.warn("[play-next] reconcile failed", e));
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
 * The tap on "Request & play next". Writes the intent and nothing else, so it is saved before the request is filed:
 * the caller files (or reuses) the request, then passes it to attachPlayNextRequest, or calls cancelPlayNext when
 * filing failed.
 */
export function recordPlayNext(result: SongRequestSearchResult): Promise<void> {
    const s = session;
    if (s == null) {
        return Promise.reject(new Error("Not signed in."));
    }
    return lock.run(async () => {
        await DbQueries.savePlayNextIntent(s.db, {
            userId: s.userId,
            externalSongId: result.externalSongId,
            songRequestId: null,
            title: result.title,
            songId: null,
            createdAt: new Date(),
        });
        await reload(s);
    });
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
