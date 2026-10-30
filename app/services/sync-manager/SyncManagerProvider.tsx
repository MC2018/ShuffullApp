import { createContext, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { addNetworkStateListener } from "expo-network";
import { useDb } from "../db/DbProvider";
import { useApi } from "../api/ApiProvider";
import { logout } from "../auth/auth";
import { SyncManager } from "./SyncManager";

interface SyncManagerProviderProps {
    userId: string;
};

const SyncManagerContext = createContext<SyncManager | null>(null);

export default function SyncManagerProvider({ userId }: SyncManagerProviderProps) {
    const db = useDb();
    const api = useApi();
    // Publish the SyncManager through state (not a module-level variable) so the context value actually
    // updates once it's created — same fix as DownloaderProvider. Harmless today (nothing reads
    // useSyncManager), but it was the same latent footgun: a static parent never republishes a module var.
    const [syncManager, setSyncManager] = useState<SyncManager | null>(null);

    useEffect(() => {
        const instance = new SyncManager(db, api, userId, logout);
        setSyncManager(instance);

        // A sync backoff built up while offline or in the background shouldn't hold queued Keeps and likes once
        // either ends (see SyncManager.syncNow).
        const network = addNetworkStateListener(({ isInternetReachable }) => {
            if (isInternetReachable === true) {
                instance.syncNow();
            }
        });
        const appState = AppState.addEventListener("change", state => {
            if (state === "active") {
                instance.syncNow();
            }
        });

        return () => {
            network.remove();
            appState.remove();
            instance.dispose();
            setSyncManager(null);
        };
    }, [db, api, userId]);

    return <SyncManagerContext.Provider value={syncManager} />
};

export function useSyncManager() {
    const context = useContext(SyncManagerContext);

    if (!context) {
        throw Error("Sync Manager Context null.");
    }

    return context;
}
