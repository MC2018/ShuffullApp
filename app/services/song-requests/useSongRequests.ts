import { useCallback } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { create } from "zustand";
import type { ApiClient } from "../api/ApiClient";
import { useApi } from "../api/ApiProvider";
import { SongRequest } from "../api/models";
import { isServerUnreachable, useServerReachability } from "../connectivity/serverReachability";
import { SongRequestStatus } from "../../enums/SongRequestStatus";
import {
    describeRequestFailure,
    newlyCompletedRequests,
    shouldPollSongRequests,
    SONG_REQUEST_POLL_MS,
    withSongRequest,
} from "../../tools/songRequests";

/** Syncs now, so a completed request's song and its requests playlist come down. Set by SyncManagerProvider. */
export function syncSoon(): void {
    useServerReachability.getState().checkNow?.();
}

// The caller's request list, one per session's api client, shared by every screen that shows it and by play-next
// (ShuffullApp#108), which reads it after syncs. A new session (another user or server) starts over empty.
interface SongRequestListState {
    api: ApiClient | null;
    /** Newest first; null until the first read. */
    requests: SongRequest[] | null;
    loadError: string | null;
    reading: boolean;
    lastTriedAt: number;
}

const EMPTY: Omit<SongRequestListState, "api"> = { requests: null, loadError: null, reading: false, lastTriedAt: 0 };
const useSongRequestList = create<SongRequestListState>(() => ({ api: null, ...EMPTY }));

/** The list as it stands for `api`'s session. */
function listFor(api: ApiClient): Omit<SongRequestListState, "api"> {
    const state = useSongRequestList.getState();
    return state.api === api ? state : EMPTY;
}

/** The last list read or applied for this session, or null when none has been. */
export function currentSongRequests(api: ApiClient): SongRequest[] | null {
    return listFor(api).requests;
}

/**
 * Reads the list again, unless a read is already running. A request seen reaching Completed syncs, so its song lands
 * in the library and this week's requests playlist.
 */
export async function refreshSongRequests(api: ApiClient): Promise<void> {
    const before = listFor(api);
    if (before.reading) {
        return;
    }
    useSongRequestList.setState({ api, ...before, reading: true, lastTriedAt: Date.now() });
    try {
        const next = await api.songRequestListMine();
        if (useSongRequestList.getState().api !== api) {
            return;
        }
        // The list as it is now, not as the read started: a request applied meanwhile counts as seen.
        const completed = newlyCompletedRequests(listFor(api).requests, next);
        useSongRequestList.setState({ requests: next, loadError: null });
        if (completed.length > 0) {
            syncSoon();
        }
    } catch (error) {
        if (useSongRequestList.getState().api === api) {
            useSongRequestList.setState({ loadError: describeRequestFailure(error) });
        }
    } finally {
        if (useSongRequestList.getState().api === api) {
            useSongRequestList.setState({ reading: false });
        }
    }
}

/** Puts a request the API just returned (create, retry, cancel) into the list at once. */
export function applySongRequest(api: ApiClient, changed: SongRequest): void {
    const current = listFor(api);
    const wasCompleted = current.requests?.find(r => r.songRequestId === changed.songRequestId)?.status === SongRequestStatus.Completed;
    useSongRequestList.setState({ api, ...current, requests: withSongRequest(current.requests ?? [], changed) });
    if (changed.status === SongRequestStatus.Completed && !wasCompleted) {
        syncSoon();
    }
}

export interface SongRequestsView {
    /** The caller's requests, newest first; null until the first read. */
    requests: SongRequest[] | null;
    /** Why the last read failed, while it is still failing. */
    loadError: string | null;
    refresh: () => Promise<void>;
    /** Puts a request the API just returned (create, retry, cancel) into the list at once. */
    apply: (changed: SongRequest) => void;
}

/**
 * The caller's song requests, read when the screen comes into focus, and while it stays in focus as often as
 * shouldPollSongRequests says: every SONG_REQUEST_POLL_MS while the producer is working on one. Not while the app is in
 * the background or the server is unreachable: a focused tab stays focused then, and the music keeps JS running.
 */
export function useSongRequests(): SongRequestsView {
    const api = useApi();
    const requests = useSongRequestList((state) => (state.api === api ? state.requests : null));
    const loadError = useSongRequestList((state) => (state.api === api ? state.loadError : null));
    const refresh = useCallback(() => refreshSongRequests(api), [api]);
    const apply = useCallback((changed: SongRequest) => applySongRequest(api, changed), [api]);

    useFocusEffect(
        useCallback(() => {
            void refresh();
            // Ticks at the fastest poll rate and decides each time, so a request this device files (apply) starts the
            // polling again without restarting the timer.
            const timer = setInterval(() => {
                const list = listFor(api);
                if (AppState.currentState === "active" && !isServerUnreachable()
                    && shouldPollSongRequests(list.requests, Date.now() - list.lastTriedAt)) {
                    void refresh();
                }
            }, SONG_REQUEST_POLL_MS);
            return () => clearInterval(timer);
        }, [api, refresh]),
    );

    return { requests, loadError, refresh, apply };
}
