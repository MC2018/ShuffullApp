import { create } from "zustand";

/**
 * Whether the app can reach the Shuffull API right now (ShuffullApp#24).
 *
 * - "unknown": nothing has tried yet this session.
 * - "reachable": the API answered the last sync, even with an error.
 * - "unreachable": the last sync got no answer or a gateway error (isUnreachableStatus), or the phone reports no
 *   internet. The shuffle then plays only downloaded songs (mediaManager getOfflinePool), and the UI says so.
 *
 * Not the same as being logged out: a 401 is an answer, and it logs out (SyncManager).
 */
export type ServerReachability = "unknown" | "reachable" | "unreachable";

interface ServerReachabilityState {
    reachability: ServerReachability;
    setReachability: (reachability: ServerReachability) => void;
    // Syncs at once, for the "Try again" button. Set by SyncManagerProvider while a session is running.
    checkNow: (() => void) | undefined;
    setCheckNow: (checkNow: (() => void) | undefined) => void;
}

export const useServerReachability = create<ServerReachabilityState>((set) => ({
    reachability: "unknown",
    setReachability: (reachability) => set({ reachability }),
    checkNow: undefined,
    setCheckNow: (checkNow) => set({ checkNow }),
}));

export function isServerUnreachable(): boolean {
    return useServerReachability.getState().reachability === "unreachable";
}
