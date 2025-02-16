import React, { createContext, useContext, useEffect, useState } from "react";
import { useDb } from "./db/DbProvider";
import { SyncManager } from "../tools";
import { useApi } from "./api/apiProvider";
import { logout } from "./LogoutProvider";

interface SyncManagerProviderProps {
    userId: number;
};

const SyncManagerContext = createContext<SyncManager | null>(null);
let syncManager: SyncManager | null = null;

export default function SyncManagerProvider({ userId }: SyncManagerProviderProps) {
    const db = useDb();
    const api = useApi();

    useEffect(() => {
        if (syncManager == null) {
            syncManager = new SyncManager(db, api, userId, logout);
        }

        return () => {
            (async () => {
                await syncManager?.dispose();
                syncManager = null;
            })();
        };
    }, []);

    return <SyncManagerContext.Provider value={syncManager} />
};

export function useSyncManager() {
    const context = useContext(SyncManagerContext);

    if (!context) {
        throw Error("Sync Manager Context null.");
    }

    return context;
}
