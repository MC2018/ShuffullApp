import * as MediaManager from "../tools/MediaManager";
import { Button } from "react-native";
import React from "react";
import { addPlaylistToDownloadQueue, DownloadPriority } from "../tools/DownloadManager";

export default function DownloadPlaylistButton() {
    const handleDownloadPlaylist = async () => {
        const playlistId = await MediaManager.getCurrentPlaylistId();

        if (playlistId == undefined || playlistId == -1) {
            return;
        }

        await addPlaylistToDownloadQueue(playlistId, DownloadPriority.Medium);
    };

    return (
        <>
        <Button onPress={handleDownloadPlaylist} title="Download Playlist" />
        </>
    );
}
