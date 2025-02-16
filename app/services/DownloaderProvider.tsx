import React, { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { useDb } from "./db/DbProvider";
import { Downloader } from "../tools";

interface DownloaderProviderProps {
    children: ReactNode;
};

const DownloaderContext = createContext<Downloader | null>(null);
let downloader: Downloader | null = null;

export default function DownloaderProvider({ children }: DownloaderProviderProps) {
    const db = useDb();

    useEffect(() => {
        if (downloader == null) {
            downloader = new Downloader(db);
        }

        return () => {
            downloader?.dispose();
            downloader = null;
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
