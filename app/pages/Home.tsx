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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { useApi } from "../services/api/apiProvider";
import { logout } from "../services/LogoutHandler";

export default function HomePage({ navigation, route }: any) {
    const { userId } = route.params;
    const db = useDb();

    if (userId == undefined || typeof userId !== "number") {
        return (
            <View>
                <Text>Loading...</Text>
            </View>
        );
    }

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
            <Button onPress={logout} title="Logout" />
            <PlayPauseButton />
            {userId != undefined ? 
                <>
                    <PlaylistSelector
                        userId={userId}
                        onPlaylistSelected={handlePlaylistSelected}></PlaylistSelector>
                </>
                :
                <>
                </>
            }
            
            <DownloadButton></DownloadButton>
            <DownloadPlaylistButton></DownloadPlaylistButton>
        </View>
        </>
    );
}
