import { Button, Text, View } from "react-native";
import { Playlist, Tag } from "../services/db/models";
import PlayPauseButton from "../components/music-control/atoms/PlayPauseButton";
import React, { useEffect, useState } from "react";
import { DownloadPriority, isAnyNullish, MediaManager, Navigator } from "../tools";
import DownloadButton from "../components/downloading/atoms/DownloadButton";
import { logout } from "../services/LogoutProvider";
import Skimmer from "../components/music-control/atoms/Skimmer";
import PlayerBar from "../components/music-control/organisms/PlayerBar";
import { createStackNavigator } from "@react-navigation/stack";
import PlaylistPage from "./Playlist";
import * as DbQueries from "@/app/services/db/queries";
import { TagList } from "../components/tags/molecules/TagList";
import { useDb } from "../services/db/DbProvider";
import GenreJamEditor from "./GenreJamEditor";
import { STORAGE_KEYS } from "../constants/storageKeys";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useDownloader } from "../services/DownloaderProvider";
import { useActiveSong } from "../tools/mediaManager";

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
    const db = useDb();
    const downloader = useDownloader();
    const { songId } = useActiveSong();
    const [ tags, setTags ] = useState<Tag[]>([]);
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

    useEffect(() => {
        (async () => {
            if (songId == undefined) {
                return;
            }

            const dbSongTags = await DbQueries.getTagsFromSong(db, songId);
            setTags(dbSongTags);
        })();
    }, [songId]);
    
    const handleDownload = async () => {
        const song = await MediaManager.getCurrentlyPlayingSong();
        
        if (isAnyNullish(song, downloader)) {
            return;
        }

        await downloader!.addSongToDownloadQueue(song!.songId, DownloadPriority.Medium);
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
                
            <Button onPress={handleGenreJamEditorSelected} title="Genre Jam Selector"></Button>
            <Button onPress={logout} title="Logout" />
            <PlayPauseButton />
            <DownloadButton onPress={handleDownload}></DownloadButton>
            <Skimmer></Skimmer>
            <TagList tags={tags}></TagList>
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}
