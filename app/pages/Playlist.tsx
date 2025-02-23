import { Button, ScrollView, Text, View, StyleSheet, TextInput } from "react-native";
import { Playlist } from "../services/db/models";
import React, { useEffect, useState } from "react";
import * as DbQueries from "../services/db/queries";
import { useDb } from "../services/db/DbProvider";
import { MediaManager } from "../tools";
import PlayerBar, { totalPlayerBarHeight } from "../components/PlayerBar";
import { SongList } from "../components/SongList";

interface PlaylistPageParams {
    playlistId: number
};

export default function PlaylistPage({ navigation, route }: any) {
    const [songs, setSongs] = useState<DbQueries.SongDetails[]>([]);
    const [playlist, setPlaylist] = useState<Playlist | null>(null);
    const [filteredSongs, setFilteredSongs] = useState<DbQueries.SongDetails[]>([]);
    const db = useDb();
    const { playlistId }: PlaylistPageParams = route.params;

    useEffect(() => {
        (async () => {
            const t = await DbQueries.getPlaylist(db, playlistId);

            if (t != undefined) {
                setPlaylist(t);
            }
            const songs = await DbQueries.getSongDetailsByPlaylist(db, playlistId);
            setSongs(songs);
            setFilteredSongs(songs);
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

    if (playlist == undefined) {
        return <></>;
    }

    return (
        <>
        <View
            style={{
                flex: 1,
                paddingBottom: totalPlayerBarHeight
            }}>
            <Text style={{fontSize: 24, marginBottom: 20}}>{playlist.name}</Text>
            <TextInput placeholder="Search" onChangeText={filterSongs}></TextInput>
            <SongList songs={filteredSongs} onSelectSong={handleSelectSong} />
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}
