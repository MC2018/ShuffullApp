import { Button, ScrollView, Text, View, StyleSheet } from "react-native";
import { Playlist } from "../services/db/models";
import React, { useEffect } from "react";
import PlaylistSelector from "../components/selectors/PlaylistSelector";
import * as DbQueries from "../services/db/queries";
import PlayerBar from "../components/PlayerBar";
import SongCollectionSelector from "../components/selectors/SongCollectionSelector";
import LocalDownloadsSelector from "../components/selectors/LocalDownloadsSelector";
import { useDb } from "../services/db/DbProvider";
import { createStackNavigator } from "@react-navigation/stack";
import { MediaManager, Navigator } from "../tools";
import { SongFilterType } from "../types/SongFilters";
import PlaylistPage from "./Playlist";

const LibraryStack = createStackNavigator();

export default function LibraryStackScreen({ navigation, route }: any) {
    return (
        <LibraryStack.Navigator screenOptions={{ headerShown: false }}>
            <LibraryStack.Screen name="Library" component={LibraryPage} initialParams={route.params} />
            <LibraryStack.Screen name="Playlist" component={PlaylistPage} initialParams={route.params} />
        </LibraryStack.Navigator>
    );
}

export function LibraryPage({ navigation, route }: any) {
    const [ playlists, setPlaylists ] = React.useState<Playlist[]>([]);
    const { userId } = route.params;
    const db = useDb();

    if (userId == undefined || typeof userId !== "number") {
        return (
            <View>
                <Text>Loading...</Text>
            </View>
        );
    }

    useEffect(() => {
        (async () => {
            setPlaylists(await DbQueries.getPlaylists(db, userId));
        })();
    }, []);

    const handleSelectPlaylist = async (playlist: Playlist) => {
        const songFilters = await MediaManager.getSongFilters();
        const newPlaylistIds = [playlist.playlistId];

        // TODO: check if filters and list are same: if they are, return early

        Navigator.toPlaylist(navigation, playlist.playlistId);

        //songFilters.setPrimaryFilter(SongFilterType.Playlist, newPlaylistIds);
        //await MediaManager.setSongFilters(songFilters, true);
    };

    return (
        <>
        <View
            style={{
            }}
            >
            <Text style={styles.header}>Your Saved Playlists</Text>
            <ScrollView horizontal={true} style={styles.parent}>
                <LocalDownloadsSelector />
                {playlists.map((playlist) => (
                    <PlaylistSelector
                        key={playlist.playlistId}
                        playlist={playlist}
                        imageSource={require("@/assets/images/default-album-art.jpg")}
                        onSelectPlaylist={handleSelectPlaylist}></PlaylistSelector>
                ))}
                <SongCollectionSelector collectionName="Liked Songs" imageSource={require("@/assets/images/default-album-art.jpg")} onSelected={() => console.log("oi")}></SongCollectionSelector>
            </ScrollView>
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}

const styles = StyleSheet.create({
    parent: {

    },
    header: {
        fontSize: 20,
        fontWeight: "bold",
    }
});
