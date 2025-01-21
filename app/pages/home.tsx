import { Button, Text, View } from "react-native";
import { useDb } from "../services/db/DbProvider";
import { useEffect, useState } from "react";
import { LocalSessionData, Playlist } from "../services/db/models";
import * as DbExtensions from "../services/db/dbExtensions";
import PlayPauseButton from "../components/PlayPauseButton";
import React from "react";
import PlaylistSelector from "../components/PlaylistSelector";
import * as MediaManager from "../tools/MediaManager";
import DownloadButton from "../components/DownloadButton";
import DownloadPlaylistButton from "../components/DownloadPlaylistButton";

interface HomeProps {
    userId: number;
    onLogout: () => void;
}

export default function HomePage({ userId, onLogout }: HomeProps) {
    const [ session, setSession ] = useState<LocalSessionData | undefined>(undefined);
    const db = useDb();

    // Logout check
    useEffect(() => {
        (async () => {
            const localSessionData = await DbExtensions.getLocalSessionData(db, userId);

            if (!localSessionData || localSessionData.expiration < new Date(Date.now())) {
                onLogout();
                return;
            }

            setSession(localSessionData);
        })();
    }, [userId]); // TODO: have this run every X minutes to continuously validate expiration

    const handlePlaylistSelected = async (playlist: Playlist | undefined) => {
        const playlistId = playlist?.playlistId ?? -1;
        const wasPlaying = await MediaManager.isPlaying();

        if (playlistId == -1) {
            return;
        }

        await MediaManager.setPlaylist(playlistId);

        if (wasPlaying) {
            await MediaManager.play();
        }
    };

    return (
        <>
        <View
            style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
            }}
            >
            <Text>Edit app/index.tsx to edit this screen.</Text>
            <Button onPress={onLogout} title="Logout" />
            <PlayPauseButton />
            <PlaylistSelector
                userId={userId}
                onPlaylistSelected={handlePlaylistSelected}></PlaylistSelector>
            <DownloadButton></DownloadButton>
            <DownloadPlaylistButton></DownloadPlaylistButton>
        </View>
        </>
    );
}
