import * as MediaManager from "../tools/MediaManager";
import { Button } from "react-native";
import React from "react";
import { addSongToDownloadQueue, DownloadPriority } from "../tools/DownloadManager";

export default function DownloadButton() {
    const handleDownload = async () => {
        const song = await MediaManager.getCurrentlyPlayingSong();

        if (song == undefined) {
            return;
        }

        await addSongToDownloadQueue(song.songId, DownloadPriority.Medium);
    };

    return (
        <>
        <Button onPress={handleDownload} title="Download" />
        </>
    );
}
