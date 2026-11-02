import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
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
 * the background or the server is unreachable: a focused tab stays focused then, and the music keeps JS running. A
 * request seen reaching Completed syncs, so its song lands in the library and this week's requests playlist.
 */
export function useSongRequests(): SongRequestsView {
    const api = useApi();
    const [requests, setRequests] = useState<SongRequest[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    // The last list read or applied, for the poll decision and the Completed check. A ref, so the timer sees it.
    const lastRead = useRef<SongRequest[] | null>(null);
    const reading = useRef(false);
    const lastTriedAt = useRef(0);

    const refresh = useCallback(async () => {
        if (reading.current) {
            return;
        }
        reading.current = true;
        lastTriedAt.current = Date.now();
        try {
            const next = await api.songRequestListMine();
            const completed = newlyCompletedRequests(lastRead.current, next);
            lastRead.current = next;
            setRequests(next);
            setLoadError(null);
            if (completed.length > 0) {
                syncSoon();
            }
        } catch (error) {
            setLoadError(describeRequestFailure(error));
        } finally {
            reading.current = false;
        }
    }, [api]);

    const apply = useCallback((changed: SongRequest) => {
        const wasCompleted = lastRead.current?.find(r => r.songRequestId === changed.songRequestId)?.status === SongRequestStatus.Completed;
        const next = withSongRequest(lastRead.current ?? [], changed);
        lastRead.current = next;
        setRequests(next);
        if (changed.status === SongRequestStatus.Completed && !wasCompleted) {
            syncSoon();
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            void refresh();
            // Ticks at the fastest poll rate and decides each time, so a request this device files (apply) starts the
            // polling again without restarting the timer.
            const timer = setInterval(() => {
                if (AppState.currentState === "active" && !isServerUnreachable()
                    && shouldPollSongRequests(lastRead.current, Date.now() - lastTriedAt.current)) {
                    void refresh();
                }
            }, SONG_REQUEST_POLL_MS);
            return () => clearInterval(timer);
        }, [refresh]),
    );

    return { requests, loadError, refresh, apply };
}
