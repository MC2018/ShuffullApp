import { MediaManager, DownloadPriority } from "../tools";
import { Button } from "react-native";
import React from "react";
import { useDownloader } from "../services/DownloaderProvider";

export default function DownloadButton() {
    const downloader = useDownloader();
    const handleDownload = async () => {
        const song = await MediaManager.getCurrentlyPlayingSong();

        if (song == undefined) {
            return;
        }

        await downloader.addSongToDownloadQueue(song.songId, DownloadPriority.Medium);
    };

    return (
        <>
        <Button onPress={handleDownload} title="Download" />
        </>
    );
}
