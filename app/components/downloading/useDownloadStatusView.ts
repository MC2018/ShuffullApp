import { useEffect, useState } from "react";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import { useDownloadStatus } from "@/app/services/downloader/downloadStatus";
import { DownloadStatus } from "@/app/tools/downloadStatus";

// The store only carries the in-flight songId (the Downloader shouldn't be doing display joins). Screens
// want the title next to the progress, so resolve it here, once per song change rather than per progress tick.
export function useDownloadStatusView(): { status: DownloadStatus; currentName: string | undefined } {
    const db = useDb();
    const status = useDownloadStatus((s) => s.status);
    const currentSongId = status.current?.songId;
    const [currentName, setCurrentName] = useState<string | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;
        if (currentSongId == undefined) {
            setCurrentName(undefined);
            return;
        }
        (async () => {
            const song = await DbQueries.getSong(db, currentSongId);
            if (!cancelled) {
                setCurrentName(song?.name);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [db, currentSongId]);

    return { status, currentName };
}
