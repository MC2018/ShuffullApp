import { Button, ScrollView, Text, View, StyleSheet } from "react-native";
import { Playlist } from "../services/db/models";
import React, { useEffect } from "react";
import PlaylistSelector from "../components/song-collection/atoms/PlaylistSelector";
import DbQueries from "../services/db/queries";
import PlayerBar from "../components/music-control/organisms/PlayerBar";
import LocalDownloadsSelector from "../components/song-collection/atoms/LocalDownloadsSelector";
import { useDb } from "../services/db/DbProvider";
import { createStackNavigator } from "@react-navigation/stack";
import { Navigator } from "../tools";
import PlaylistPage from "./Playlist";
import LocalDownloadsPage from "./LocalDownloads";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import SongCollectionScrollView from "@/app/components/song-collection/molecules/SongCollectionScrollView";

const LibraryStack = createStackNavigator();

export default function LibraryStackScreen({ navigation, route }: any) {
    return (
        <LibraryStack.Navigator screenOptions={{ headerShown: false }}>
            <LibraryStack.Screen name="Library" component={LibraryPage} initialParams={route.params} />
            <LibraryStack.Screen name="Playlist" component={PlaylistPage} initialParams={route.params} />
            <LibraryStack.Screen name="LocalDownloads" component={LocalDownloadsPage} initialParams={route.params} />
        </LibraryStack.Navigator>
    );
}

export function LibraryPage({ navigation, route }: any) {
    const [ playlists, setPlaylists ] = React.useState<Playlist[]>([]);
    const [ userId, setUserId ] = React.useState<string | undefined>(undefined);
    const db = useDb();

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
            if (userId != undefined) {
                setPlaylists(await DbQueries.getPlaylists(db, userId));
            }
        })();
    }, [userId]);

    if (userId == undefined || typeof userId !== "string") {
        return (
            <View>
                <Text>Loading...</Text>
            </View>
        );
    }

    const handleSelectPlaylist = async (playlist: Playlist) => {
        Navigator.toPlaylist(navigation, playlist.playlistId);
    };

    return (
        <>
            <View>
                <Text style={styles.header}>Your Saved Playlists</Text>
                <SongCollectionScrollView playlists={playlists} onSelected={handleSelectPlaylist}></SongCollectionScrollView>
            </View>
            <PlayerBar></PlayerBar>
        </>
    );
}

const styles = StyleSheet.create({
    header: {
        fontSize: 20,
        fontWeight: "bold",
    }
});
