import { Button, Text, View } from "react-native";
import { Playlist } from "../services/db/models";
import PlayPauseButton from "../components/PlayPauseButton";
import React from "react";
import { MediaManager } from "../tools";
import DownloadButton from "../components/DownloadButton";
import DownloadPlaylistButton from "../components/DownloadPlaylistButton";
import { logout } from "../services/LogoutProvider";
import Skimmer from "../components/Skimmer";
import PlayerBar from "../components/PlayerBar";

export default function HomePage({ navigation, route }: any) {
    const { userId } = route.params;

    if (userId == undefined || typeof userId !== "number") {
        return (
            <View>
                <Text>Loading...</Text>
            </View>
        );
    }

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
            <DownloadButton></DownloadButton>
            <Skimmer></Skimmer>
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}
