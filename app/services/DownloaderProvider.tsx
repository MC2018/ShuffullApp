import React, { createContext, useContext, useEffect, useState } from "react";
import { ReactNode } from 'react';
import { useDb } from "./db/DbProvider";
import { Downloader } from "../tools";

interface DownloaderProviderProps {
    children: ReactNode;
};

const DownloaderContext = createContext<Downloader | null>(null);

export default function DownloaderProvider({ children }: DownloaderProviderProps) {
    const [ timerIncrement, setTimerIncrement ] = useState(0);
    const db = useDb();
    const [ downloader, setDownloader ] = useState(new Downloader(db));

    useEffect(() => {
        return () => {
            downloader.dispose();
        };
    }, []);

    return <DownloaderContext.Provider value={downloader}>{children}</DownloaderContext.Provider>
};

export function useDownloader() {
    const context = useContext(DownloaderContext);

    if (!context) {
        throw Error("Downloader Context null.");
    }

    return context;
}
