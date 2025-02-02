import * as MediaManager from "../tools/MediaManager";
import { Button } from "react-native";
import React from "react";
import { useDownloader } from "../services/DownloaderProvider";
import { DownloadPriority } from "../tools/Downloader";

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
