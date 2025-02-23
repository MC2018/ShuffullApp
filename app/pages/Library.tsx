import { Button, ScrollView, Text, View, StyleSheet } from "react-native";
import { Playlist } from "../services/db/models";
import React from "react";
import PlaylistSelector from "../components/selectors/PlaylistSelector";
import * as DbQueries from "../services/db/queries";
import PlayerBar from "../components/PlayerBar";
import SongCollectionSelector from "../components/selectors/SongCollectionSelector";
import LocalDownloadsSelector from "../components/selectors/LocalDownloadsSelector";
import { useDb } from "../services/db/DbProvider";
import { createStackNavigator } from "@react-navigation/stack";

const SongStack = createStackNavigator();

export default function LibraryStackScreen({ navigation, route }: any) {
    
    return (
        <SongStack.Navigator screenOptions={{ headerShown: false }}>
            <SongStack.Screen name="Library" component={LibraryPage} initialParams={route.params} />
        </SongStack.Navigator>
    );
}

export function LibraryPage({ navigation, route }: any) {
    const [ playlists, setPlaylists ] = React.useState<Playlist[]>([]);
    const { userId } = route.params;
    const db = useDb();

    React.useEffect(() => {
        (async () => {
            setPlaylists(await DbQueries.getPlaylists(db, userId));
        })();
    }, []);

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
                        onSelected={() => console.log("oi")}></PlaylistSelector>
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
