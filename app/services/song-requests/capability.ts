import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { create } from "zustand";
import type { ApiClient } from "../api/ApiClient";
import { useApi } from "../api/ApiProvider";
import { shouldAskCapabilities, songRequestsCapability, SongRequestsCapability } from "../../tools/songRequests";

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

    let outcome: Parameters<typeof songRequestsCapability>[0];
    try {
        outcome = { capabilities: await api.capabilitiesGet() };
    } catch (error) {
        outcome = { error };
    }
    if (useCapabilityStore.getState().api !== api) {
        return;
    }
    const songRequests = songRequestsCapability(outcome);
    useCapabilityStore.setState({ songRequests, askedAt: songRequests === "unknown" ? null : Date.now(), asking: false });
}

/**
 * Whether to show song requests at all: only once this server has said `songRequests: true`. Asks when a screen using
 * it comes into focus and the answer is unknown or an hour old; until then the feature stays hidden.
 */
export function useSongRequestsEnabled(): boolean {
    const api = useApi();
    const enabled = useCapabilityStore((state) => state.api === api && state.songRequests === "on");
    useFocusEffect(
        useCallback(() => {
            void askCapabilities(api);
        }, [api]),
    );
    return enabled;
}
