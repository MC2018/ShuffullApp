import { Button, ScrollView, Text, View, StyleSheet, TextInput } from "react-native";
import { Playlist } from "../services/db/models";
import React, { useEffect, useState } from "react";
import * as DbQueries from "../services/db/queries";
import { useDb } from "../services/db/DbProvider";
import { MediaManager } from "../tools";
import PlayerBar, { totalPlayerBarHeight } from "../components/music-control/organisms/PlayerBar";
import { SongList } from "../components/songs/molecules/SongList";

export default function LocalDownloadsPage({ navigation, route }: any) {
    const [songs, setSongs] = useState<DbQueries.SongDetails[]>([]);
    const [filteredSongs, setFilteredSongs] = useState<DbQueries.SongDetails[]>([]);
    const db = useDb();

    useEffect(() => {
        (async () => {
            const dbSongs = await DbQueries.getDownloadedSongDetails(db);
            setSongs(dbSongs);
            setFilteredSongs(dbSongs);
        })();
    }, []);

    const filterSongs = async (search: string) => {
        if (search == "") {
            setFilteredSongs(songs);
            return;
        }

        const filtered = songs.filter(x => x.song.name.toLowerCase().includes(search.toLowerCase()) || x.artists.map(y => y.name).join(", ").toLowerCase().includes(search.toLowerCase()));
        setFilteredSongs(filtered);
    }

    const handleSelectSong = async (songDetails: DbQueries.SongDetails) => {
        await MediaManager.playSpecificSong(songDetails.song.songId);
    };

    return (
        <>
        <View
            style={{
                flex: 1,
                paddingBottom: totalPlayerBarHeight
            }}>
            <Text style={{fontSize: 24, marginBottom: 20}}>Downloaded Songs</Text>
            <TextInput placeholder="Search" onChangeText={filterSongs}></TextInput>
            <SongList songs={filteredSongs} onSelectSong={handleSelectSong} />
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}
