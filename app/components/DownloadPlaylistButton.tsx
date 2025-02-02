import * as MediaManager from "../tools/MediaManager";
import { Button } from "react-native";
import React from "react";
import { DownloadPriority } from "../tools/Downloader";
import { useDownloader } from "../services/DownloaderProvider";

export default function DownloadPlaylistButton() {
    const downloader = useDownloader();
    const handleDownloadPlaylist = async () => {
        const playlistId = await MediaManager.getCurrentPlaylistId();

        if (playlistId == undefined || playlistId == -1) {
            return;
        }

        await downloader.addPlaylistToDownloadQueue(playlistId, DownloadPriority.Medium);
    };

    return (
        <>
        <Button onPress={handleDownloadPlaylist} title="Download Playlist" />
        </>
    );
}
