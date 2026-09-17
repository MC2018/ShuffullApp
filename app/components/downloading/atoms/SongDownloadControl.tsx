import React, { useEffect, useState } from "react";
import { Downloader } from "@/app/services/downloader/Downloader";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { useDownloadStatus } from "@/app/services/downloader/downloadStatus";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import { DownloadPriority } from "@/app/services/db/types";
import { Song } from "@/app/services/db/models";
import IconButton from "@/app/components/ui/IconButton";
import { useTheme } from "@/app/theme";

type DownloadState = "none" | "queued" | "downloaded";

// Per-song download toggle. "downloaded" = the audio file exists locally; "queued" = a row is in the download
// queue (checked in the DB, not just remembered from the tap, so reopening the song shows the truth).
// Re-checked whenever the Downloader reports a change (queue size, in-flight song, or a completion), which
// is how a "queued" here turns into "downloaded" without polling. Tapping a queued song un-queues it.
export default function SongDownloadControl({ song }: { song: Song }) {
    const theme = useTheme();
    const db = useDb();
    const downloader = useDownloader();
    const status = useDownloadStatus((s) => s.status);
    const [state, setState] = useState<DownloadState>("none");
    const localUri = Downloader.generateLocalSongUri(song);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const exists = await Downloader.fileExists(localUri);
            const queued = exists ? false : await DbQueries.isSongInDownloadQueue(db, song.songId);
            if (!cancelled) {
                setState(exists ? "downloaded" : queued ? "queued" : "none");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [db, song.songId, localUri, status.queuedCount, status.completedCount, status.current?.songId]);

    const onPress = async () => {
        if (!downloader) {
            return;
        }
        if (state === "none") {
            setState("queued");
            await downloader.addSongToDownloadQueue(song.songId, DownloadPriority.Medium);
        } else if (state === "queued") {
            setState("none");
            await downloader.removeFromQueue(song.songId);
        }
    };

    // Stay download-iconography throughout: muted = not saved (matches the adjacent like/add buttons),
    // wine = queued, green (filled) = downloaded.
    const icon = state === "downloaded" ? "download" : "download-outline";
    const color =
        state === "downloaded" ? theme.color.positive : state === "queued" ? theme.color.accent : theme.color.textMuted;
    const label = state === "downloaded" ? "Downloaded" : state === "queued" ? "Remove from download queue" : "Download song";

    return <IconButton name={icon} size={22} color={color} onPress={onPress} accessibilityLabel={label} />;
}
