import { Button, Text, View } from "react-native";
import { Playlist } from "../services/db/models";
import PlayPauseButton from "../components/PlayPauseButton";
import React, { useEffect, useState } from "react";
import { MediaManager, Navigator } from "../tools";
import DownloadButton from "../components/DownloadButton";
import DownloadPlaylistButton from "../components/DownloadPlaylistButton";
import { logout } from "../services/LogoutProvider";
import Skimmer from "../components/Skimmer";
import PlayerBar from "../components/PlayerBar";
import { createStackNavigator } from "@react-navigation/stack";
import PlaylistPage from "./Playlist";
import { SongTagList } from "../components/SongTagList";
import { useDb } from "../services/db/DbProvider";
import GenreJamEditor from "./GenreJamEditor";
import { STORAGE_KEYS } from "../constants/storageKeys";
import AsyncStorage from "@react-native-async-storage/async-storage";

const HomeStack = createStackNavigator();

export default function HomeStackScreen({ navigation, route }: any) {
    return (
        <HomeStack.Navigator screenOptions={{ headerShown: false }}>
            <HomeStack.Screen name="Home" component={HomePage} initialParams={route.params} />
            <HomeStack.Screen name="GenreJamEditor" component={GenreJamEditor} initialParams={route.params} />
        </HomeStack.Navigator>
    );
}

export function HomePage({ navigation, route }: any) {
    const [ userId, setUserId ] = useState<string | null>(null);

    const handleGenreJamEditorSelected = () => {
        if (userId == null) {
            return;
        }

        Navigator.toGenreJamEditor(navigation, userId);
    };

    useEffect(() => {
        (async () => {
            const cachedUserId = await AsyncStorage.getItem(STORAGE_KEYS.CURRENT_USER_ID);

            if (cachedUserId == null) {
                return;
            }

            setUserId(cachedUserId);
        })();
    }, []);

    return (
        <>
        <View
            style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
            }}
            >
                
            <Button onPress={handleGenreJamEditorSelected} title="Genre Jam Selector"></Button>
            <Button onPress={logout} title="Logout" />
            <PlayPauseButton />
            <DownloadButton></DownloadButton>
            <Skimmer></Skimmer>
            <SongTagList></SongTagList>
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}
