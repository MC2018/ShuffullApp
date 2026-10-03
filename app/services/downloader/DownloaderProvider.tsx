import React, { createContext, ReactNode, useContext, useMemo } from "react";
import { useDb } from "../db/DbProvider";
import { Downloader } from "./Downloader";

interface DownloaderProviderProps {
    children: ReactNode;
};

const DownloaderContext = createContext<Downloader | null>(null);

// Hands screens the process-wide Downloader. It used to CREATE one per mount and dispose it on unmount,
// which is exactly wrong for a background job: on Android the tree unmounts when the app is swiped away
// while the process (and the foreground service, and its notification) lives on — so the loop died
// silently under a notification claiming otherwise. The singleton outlives the tree; this only publishes it.
export default function DownloaderProvider({ children }: DownloaderProviderProps) {
    const db = useDb();
    const downloader = useMemo(() => Downloader.shared(db), [db]);

    return <DownloaderContext.Provider value={downloader}>{children}</DownloaderContext.Provider>
};

export function useDownloader(): Downloader | null {
    const context = useContext(DownloaderContext);

    return context;
}
