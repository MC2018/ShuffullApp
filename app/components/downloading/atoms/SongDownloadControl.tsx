import React, { useEffect, useState } from "react";
import { Downloader } from "@/app/services/downloader/Downloader";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { DownloadPriority } from "@/app/services/db/types";
import { Song } from "@/app/services/db/models";
import IconButton from "@/app/components/ui/IconButton";
import { useTheme } from "@/app/theme";

type DownloadState = "none" | "queued" | "downloaded";

// Per-song download toggle. Reflects whether the audio file already exists locally; tapping queues a
// download (optimistic "queued" state). Completion happens in the background Downloader loop — we re-check
// existence when the song changes rather than polling.
export default function SongDownloadControl({ song }: { song: Song }) {
    const theme = useTheme();
    const downloader = useDownloader();
    const [state, setState] = useState<DownloadState>("none");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const exists = await Downloader.fileExists(Downloader.generateLocalSongUri(song));
            if (!cancelled) {
                setState(exists ? "downloaded" : "none");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [song.songId]);

    const onPress = async () => {
        if (state !== "none" || !downloader) {
            return;
        }
        setState("queued");
        await downloader.addSongToDownloadQueue(song.songId, DownloadPriority.Medium);
    };

    const icon = state === "downloaded" ? "checkmark-circle" : state === "queued" ? "time-outline" : "download-outline";
    const color = state === "downloaded" ? theme.color.positive : theme.color.textMuted;

    return <IconButton name={icon} size={22} color={color} onPress={onPress} accessibilityLabel="Download song" />;
}
