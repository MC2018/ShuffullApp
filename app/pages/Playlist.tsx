import { Button, ScrollView, Text, View, StyleSheet, TextInput } from "react-native";
import { Playlist } from "../services/db/models";
import React, { useEffect, useState } from "react";
import * as DbQueries from "../services/db/queries";
import { useDb } from "../services/db/DbProvider";
import { DownloadPriority, MediaManager } from "../tools";
import PlayerBar, { totalPlayerBarHeight } from "../components/PlayerBar";
import { SongList } from "../components/SongList";
import { useDownloader } from "../services/DownloaderProvider";
import { SongFilterType } from "../types/SongFilters";

interface PlaylistPageParams {
    playlistId: number
};

export default function PlaylistPage({ navigation, route }: any) {
    const [songs, setSongs] = useState<DbQueries.SongDetails[]>([]);
    const [playlist, setPlaylist] = useState<Playlist | null>(null);
    const [filteredSongs, setFilteredSongs] = useState<DbQueries.SongDetails[]>([]);
    const db = useDb();
    const downloader = useDownloader();
    const { playlistId }: PlaylistPageParams = route.params;

    useEffect(() => {
        (async () => {
            const dbPlaylist = await DbQueries.getPlaylist(db, playlistId);

            if (dbPlaylist == undefined) {
                // TODO: fetch playlist info from server
                throw new Error("Playlist not in DB");
            }

            setPlaylist(dbPlaylist);

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

    const downloadPlaylist = async () => {
        await downloader?.addPlaylistToDownloadQueue(playlistId, DownloadPriority.Medium);
    };

    const playPlaylist = async () => {
        const songFilters = await MediaManager.getSongFilters();
        const newPlaylistIds = [playlist.playlistId];

        // TODO: check if filters and list are same: if they are, return early
        songFilters.setPrimaryFilter(SongFilterType.Playlist, newPlaylistIds);
        await MediaManager.setSongFilters(songFilters, true);
    };

    return (
        <>
        <View
            style={{
                flex: 1,
                paddingBottom: totalPlayerBarHeight
            }}>
            <Text style={{fontSize: 24, marginBottom: 20}}>{playlist.name}</Text>
            <TextInput placeholder="Search" onChangeText={filterSongs}></TextInput>
            <Button title="Download" onPress={downloadPlaylist}></Button>
            <Button title="Play" onPress={playPlaylist}></Button>
            <SongList songs={filteredSongs} onSelectSong={handleSelectSong} />
        </View>
        <PlayerBar></PlayerBar>
        </>
    );
}
