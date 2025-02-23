import { View, Text, FlatList, TextInput } from "react-native";
import { useDb } from "../services/db/DbProvider";
import { useEffect, useState } from "react";
import * as DbQueries from "../services/db/queries";
import { MediaManager } from "../tools";
import React from "react";
import PlayerBar, { totalPlayerBarHeight } from "../components/PlayerBar";
import { createStackNavigator } from "@react-navigation/stack";

const SongStack = createStackNavigator();

export default function SongsStackScreen() {
    return (
        <SongStack.Navigator screenOptions={{ headerShown: false }}>
            <SongStack.Screen name="Song" component={SongsPage} />
        </SongStack.Navigator>
    );
}

export function SongsPage() {
    const [songs, setSongs] = useState<DbQueries.SongWithArtists[]>([]);
    const [filteredSongs, setFilteredSongs] = useState<DbQueries.SongWithArtists[]>([]);
    const db = useDb();

    useEffect(() => {
        (async () => {
            const songs = await DbQueries.getAllSongsWithArtists(db);
            setSongs(songs);
            setFilteredSongs(songs);
        })();
    }, []);

    const selectSong = async (songInfo: DbQueries.SongWithArtists) => {
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
            <FlatList data={filteredSongs} renderItem={({ item }) => 
                <View style={{margin: 5}} onTouchEnd={() => selectSong(item)}>
                    <Text style={{fontSize: 18}}>{item.song.name}</Text>
                    <Text>
                        {item.artists.length > 0 ? item.artists.map(x => x.name).join(", ") : "Unknown Artist"}
                    </Text>
                </View>
            } />
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}