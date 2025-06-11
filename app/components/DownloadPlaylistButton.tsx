import { MediaManager, DownloadPriority } from "../tools";
import { Button } from "react-native";
import React from "react";
import { useDownloader } from "../services/DownloaderProvider";
import { Playlist } from "../services/db/models";

export interface DownloadPlaylistProps {
    playlist: Playlist;
    onSelected: () => void;
}

export default function DownloadPlaylistButton({ playlist }: DownloadPlaylistProps) {
    const downloader = useDownloader()!;
    const handleDownloadPlaylist = async () => {
        await downloader.addPlaylistToDownloadQueue(playlist.playlistId, DownloadPriority.Medium);
    };

    return (
        <>
        <Button onPress={handleDownloadPlaylist} title="Download Playlist" />
        </>
    );
}
