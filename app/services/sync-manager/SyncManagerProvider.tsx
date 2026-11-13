import { createContext, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { addNetworkStateListener } from "expo-network";
import { useDb } from "../db/DbProvider";
import { useApi } from "../api/ApiProvider";
import { logout } from "../auth/auth";
import { logoutUnlessReplaced } from "../auth/passwordChange";
import { useServerReachability } from "../connectivity/serverReachability";
import { reconcilePlayNext, startPlayNext } from "../song-requests/playNext";
import { checkInDeviceOnReconnect, startDeviceCheckIn } from "../device";
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
        // Play-next intents queue their song once a sync brings it down (ShuffullApp#108).
        const stopPlayNext = startPlayNext(db, api, userId);
        // Tells the server this install is open: now (a start signed in, or a login) and on each foreground
        // (ShuffullApp#58).
        const stopDeviceCheckIn = startDeviceCheckIn(api);
        // A 401 on a token a password change has just replaced isn't this session ending (see logoutUnlessReplaced).
        const instance = new SyncManager(db, api, userId, () => logoutUnlessReplaced(api, logout),
            () => void reconcilePlayNext({ readRequests: true }));
        setSyncManager(instance);
        const reachability = useServerReachability.getState();
        reachability.setCheckNow(() => instance.syncNow());

        // A sync backoff built up while offline or in the background shouldn't hold queued Keeps and likes once
        // either ends (see SyncManager.syncNow).
        // Losing the connection needn't wait for a sync to fail: the shuffle can switch to downloads at once. Only the
        // next sync that reaches the API says the server is back, since a working connection doesn't prove that.
        const network = addNetworkStateListener(({ isInternetReachable }) => {
            if (isInternetReachable === true) {
                instance.syncNow();
                checkInDeviceOnReconnect();
            } else if (isInternetReachable === false) {
                useServerReachability.getState().setReachability("unreachable");
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
            stopPlayNext();
            stopDeviceCheckIn();
            setSyncManager(null);
            // The next session (another user, another server) finds out for itself.
            reachability.setCheckNow(undefined);
            reachability.setReachability("unknown");
        };
    }, [db, api, userId]);

    return <SyncManagerContext.Provider value={syncManager} />;
};

export function useSyncManager() {
    const context = useContext(SyncManagerContext);

    if (!context) {
        throw Error("Sync Manager Context null.");
    }

    return context;
}
