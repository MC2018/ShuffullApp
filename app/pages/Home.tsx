import { Button, Text, View } from "react-native";
import { Playlist } from "../services/db/models";
import PlayPauseButton from "../components/PlayPauseButton";
import React from "react";
import PlaylistSelector from "../components/PlaylistSelector";
import { MediaManager } from "../tools";
import DownloadButton from "../components/DownloadButton";
import DownloadPlaylistButton from "../components/DownloadPlaylistButton";
import { logout } from "../services/LogoutProvider";
import Skimmer from "../components/Skimmer";

export default function HomePage({ navigation, route }: any) {
    const { userId } = route.params;

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
            <Skimmer></Skimmer>
        </View>
        </>
    );
}
