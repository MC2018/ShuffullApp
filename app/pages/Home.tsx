import { Button, Text, View } from "react-native";
import { Playlist } from "../services/db/models";
import PlayPauseButton from "../components/PlayPauseButton";
import React from "react";
import { MediaManager, Navigator } from "../tools";
import DownloadButton from "../components/DownloadButton";
import DownloadPlaylistButton from "../components/DownloadPlaylistButton";
import { logout } from "../services/LogoutProvider";
import Skimmer from "../components/Skimmer";
import PlayerBar from "../components/PlayerBar";
import { createStackNavigator } from "@react-navigation/stack";
import PlaylistPage from "./Playlist";

const HomeStack = createStackNavigator();

export default function HomeStackScreen({ navigation, route }: any) {
    return (
        <HomeStack.Navigator screenOptions={{ headerShown: false }}>
            <HomeStack.Screen name="Home" component={HomePage} initialParams={route.params} />
        </HomeStack.Navigator>
    );
}

export function HomePage({ navigation, route }: any) {
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
