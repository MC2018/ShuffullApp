import React, { useEffect, useState } from "react";
import { View } from "react-native";
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
import { Button, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

export default function PlaylistScreen() {
    const theme = useTheme();
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
            const dbSongs = await DbQueries.getSongDetailsByPlaylist(db, playlistId);
            setSongs(dbSongs);
            setFilteredSongs(dbSongs);
        })();
    }, [playlistId]);

    const filterSongs = (search: string) => {
        if (search === "") {
            setFilteredSongs(songs);
            return;
        }
        const q = search.toLowerCase();
        setFilteredSongs(
            songs.filter(
                (x) => x.song.name.toLowerCase().includes(q) || x.artists.map((y) => y.name).join(", ").toLowerCase().includes(q),
            ),
        );
    };

    const handleSelectSong = async (songDetails: SongDetails) => {
        await MediaManager.playSpecificSong(songDetails.song.songId);
    };

    if (playlist == undefined) {
        return <Screen><View style={{ flex: 1 }} /></Screen>;
    }

    const downloadPlaylist = async () => {
        await downloader?.addPlaylistToDownloadQueue(playlist.playlistId, DownloadPriority.Medium);
    };

    const playPlaylist = async () => {
        const songFilters = await MediaManager.getSongFilters();
        // TODO: check if filters and list are same: if they are, return early
        songFilters.setSoleFilter(SongFilterType.Playlist, [playlist.playlistId]);
        await MediaManager.setSongFilters(songFilters, true);
    };

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" numberOfLines={1} style={{ marginTop: theme.space.md }}>
                    {playlist.name}
                </Text>
                <Text variant="caption" color="textFaint" style={{ marginTop: 2, marginBottom: theme.space.md }}>
                    {songs.length} songs
                </Text>
                <View style={{ flexDirection: "row", gap: theme.space.sm, marginBottom: theme.space.md }}>
                    <Button label="Play" icon="play" onPress={playPlaylist} style={{ flex: 1 }} />
                    <Button label="Download" icon="download-outline" variant="ghost" onPress={downloadPlaylist} style={{ flex: 1 }} />
                </View>
                <TextField
                    placeholder="Search in playlist"
                    onChangeText={filterSongs}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ marginBottom: theme.space.md }}
                />
                <SongList songs={filteredSongs} onSelectSong={handleSelectSong} />
            </View>
            <PlayerBar />
        </Screen>
    );
}
