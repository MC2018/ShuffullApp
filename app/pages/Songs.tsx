import { View, Text, FlatList, TextInput } from "react-native";
import { useDb } from "../services/db/DbProvider";
import { useEffect, useState } from "react";
import DbQueries from "../services/db/queries";
import React from "react";
import PlayerBar, { totalPlayerBarHeight } from "../components/music-control/organisms/PlayerBar";
import { createStackNavigator } from "@react-navigation/stack";
import { SongList } from "../components/songs/molecules/SongList";
import { SongDetails } from "../services/db/types";
import { MediaManager } from "../services/media-manager";

const SongStack = createStackNavigator();

export default function SongsStackScreen({ navigation, route }: any) {
    return (
        <SongStack.Navigator screenOptions={{ headerShown: false }}>
            <SongStack.Screen name="Song" component={SongsPage} initialParams={route.params} />
        </SongStack.Navigator>
    );
}

export function SongsPage() {
    const [songs, setSongs] = useState<SongDetails[]>([]);
    const [filteredSongs, setFilteredSongs] = useState<SongDetails[]>([]);
    const db = useDb();

    useEffect(() => {
        (async () => {
            const songs = await DbQueries.getAllSongDetails(db);
            setSongs(songs);
            setFilteredSongs(songs);
        })();
    }, []);

    const handleSelectSong = async (songInfo: SongDetails) => {
        await MediaManager.playSpecificSong(songInfo.song.songId);
    };

    const filterSongs = async (search: string) => {
        if (search == "") {
            setFilteredSongs(songs);
            return;
        }

        const filtered = songs.filter(x => x.song.name.toLowerCase().includes(search.toLowerCase()) || x.artists.map(y => y.name).join(", ").toLowerCase().includes(search.toLowerCase()));
        setFilteredSongs(filtered);
    }

    return (
        <>
        <View
            style={{
                flex: 1,
                paddingBottom: totalPlayerBarHeight
            }}>
            <Text style={{fontSize: 24, marginBottom: 20}}>Songs</Text>
            <TextInput placeholder="Search" onChangeText={filterSongs}></TextInput>
            <SongList songs={filteredSongs} onSelectSong={handleSelectSong} />
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}
