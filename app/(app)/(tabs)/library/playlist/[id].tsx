import { Button, Text, View, TextInput } from "react-native";
import React, { useEffect, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Playlist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import { SongFilterType } from "@/app/types/SongFilters";
import { DownloadPriority, SongDetails } from "@/app/services/db/types";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { MediaManager } from "@/app/services/media-manager";

export default function PlaylistScreen() {
    const { id: playlistId } = useLocalSearchParams<{ id: string }>();
    const [songs, setSongs] = useState<SongDetails[]>([]);
    const [playlist, setPlaylist] = useState<Playlist | null>(null);
    const [filteredSongs, setFilteredSongs] = useState<SongDetails[]>([]);
    const db = useDb();
    const downloader = useDownloader();

    useEffect(() => {
        if (playlistId == undefined) {
            return;
        }

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
    }, [playlistId]);

    const filterSongs = async (search: string) => {
        if (search == "") {
            setFilteredSongs(songs);
            return;
        }

        const filtered = songs.filter(x => x.song.name.toLowerCase().includes(search.toLowerCase()) || x.artists.map(y => y.name).join(", ").toLowerCase().includes(search.toLowerCase()));
        setFilteredSongs(filtered);
    };

    const handleSelectSong = async (songDetails: SongDetails) => {
        await MediaManager.playSpecificSong(songDetails.song.songId);
    };

    if (playlist == undefined) {
        return <></>;
    }

    const downloadPlaylist = async () => {
        await downloader?.addPlaylistToDownloadQueue(playlist.playlistId, DownloadPriority.Medium);
    };

    const playPlaylist = async () => {
        const songFilters = await MediaManager.getSongFilters();
        const newPlaylistIds = [playlist.playlistId];

        // TODO: check if filters and list are same: if they are, return early
        songFilters.setSoleFilter(SongFilterType.Playlist, newPlaylistIds);
        await MediaManager.setSongFilters(songFilters, true);
    };

    return (
        <>
            <View
                style={{
                    flex: 1,
                    paddingBottom: totalPlayerBarHeight
                }}>
                <Text style={{ fontSize: 24, marginBottom: 20 }}>{playlist.name}</Text>
                <TextInput placeholder="Search" onChangeText={filterSongs}></TextInput>
                <Button title="Download" onPress={downloadPlaylist}></Button>
                <Button title="Play" onPress={playPlaylist}></Button>
                <SongList songs={filteredSongs} onSelectSong={handleSelectSong} />
            </View>
            <PlayerBar></PlayerBar>
        </>
    );
}
