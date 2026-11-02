import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { create } from "zustand";
import type { ApiClient } from "../api/ApiClient";
import { useApi } from "../api/ApiProvider";
import { nextCapabilityAnswer, shouldAskCapabilities, SongRequestsCapability } from "../../tools/songRequests";

// The server's answer to GET /capabilities, for the session's api client. A new session (another user or server) gets a
// new client, which starts over at "unknown".
interface CapabilityState {
    api: ApiClient | null;
    songRequests: SongRequestsCapability;
    askedAt: number | null;
    asking: boolean;
}

const useCapabilityStore = create<CapabilityState>(() => ({ api: null, songRequests: "unknown", askedAt: null, asking: false }));

async function askCapabilities(api: ApiClient): Promise<void> {
    const state = useCapabilityStore.getState();
    const current = state.api === api ? state : { songRequests: "unknown" as const, askedAt: null, asking: false };
    if (current.asking || !shouldAskCapabilities(current.songRequests, current.askedAt, Date.now())) {
        return;
    }
    useCapabilityStore.setState({ api, songRequests: current.songRequests, askedAt: current.askedAt, asking: true });

    let outcome: Parameters<typeof nextCapabilityAnswer>[1];
    try {
        outcome = { capabilities: await api.capabilitiesGet() };
    } catch (error) {
        outcome = { error };
    }
    if (useCapabilityStore.getState().api !== api) {
        return;
    }
    useCapabilityStore.setState({ ...nextCapabilityAnswer(current, outcome, Date.now()), asking: false });
}

export interface SongRequestsCapabilityView {
    capability: SongRequestsCapability;
    /** An ask is in flight. */
    asking: boolean;
    /** Ask now, unless the answer is known and fresh. */
    ask: () => void;
}

/**
 * What this server has said about song requests, for this session. Asks when a screen using it comes into focus and
 * the answer is unknown or an hour old.
 */
export function useSongRequestsCapability(): SongRequestsCapabilityView {
    const api = useApi();
    const capability = useCapabilityStore((state) => (state.api === api ? state.songRequests : "unknown"));
    const asking = useCapabilityStore((state) => state.api === api && state.asking);
    const ask = useCallback(() => void askCapabilities(api), [api]);
    useFocusEffect(ask);
    return { capability, asking, ask };
}

/** Whether to show song requests at all: only once this server has said `songRequests: true`. */
export function useSongRequestsEnabled(): boolean {
    return useSongRequestsCapability().capability === "on";
}
