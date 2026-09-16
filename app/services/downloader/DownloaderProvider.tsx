import React, { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { useDb } from "../db/DbProvider";
import { Downloader } from "./Downloader";

interface DownloaderProviderProps {
    children: ReactNode;
};

const DownloaderContext = createContext<Downloader | null>(null);

export default function DownloaderProvider({ children }: DownloaderProviderProps) {
    const db = useDb();
    // Publish the Downloader through state (not a module-level variable) so the context value
    // actually updates once the instance is created in the effect. The old module-variable approach
    // left the context frozen at null unless a parent re-render happened to republish it — the former
    // god-component re-rendered constantly so it worked by accident, but the static root layout never
    // re-renders, so useDownloader() stayed null and every download silently no-op'd.
    const [downloader, setDownloader] = useState<Downloader | null>(null);

    useEffect(() => {
        const instance = new Downloader(db);
        setDownloader(instance);

        return () => {
            instance.dispose();
            setDownloader(null);
        };
    }, [db]);

    return <DownloaderContext.Provider value={downloader}>{children}</DownloaderContext.Provider>
};

export function useDownloader(): Downloader | null {
    const context = useContext(DownloaderContext);

    return context;
}
