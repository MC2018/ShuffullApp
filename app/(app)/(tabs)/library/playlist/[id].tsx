import React, { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Playlist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import { SongFilterType } from "@/app/types/SongFilters";
import { DownloadPriority, SongDetails } from "@/app/services/db/types";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { Downloader } from "@/app/services/downloader/Downloader";
import { MediaManager } from "@/app/services/media-manager";
import { Button, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { RequestType } from "@/app/enums";
import { generateId } from "@/app/tools";

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

    const confirmDelete = () => {
        const message = playlist.isExploratory
            ? "Delete this audition playlist? Songs you didn't keep will be removed from your library; kept (liked) songs stay."
            : "Delete this playlist? Its songs stay in your library.";
        Alert.alert("Delete playlist", message, [
            { text: "Cancel", style: "cancel" },
            {
                text: "Delete",
                style: "destructive",
                onPress: async () => {
                    // Purge locally (mirrors the server) and clean up any downloaded media for the removed songs.
                    const purged = await DbQueries.deletePlaylistAndPurge(db, playlist.playlistId);
                    for (const song of purged) {
                        await Downloader.deleteLocalSongFiles(song);
                    }
                    // Tell the server (also performs the purge). Queued so a delete made offline still lands.
                    await DbQueries.addRequests(db, [
                        {
                            requestId: generateId(),
                            timeRequested: new Date(),
                            requestType: RequestType.DeletePlaylist,
                            userId: playlist.userId,
                            playlistId: playlist.playlistId,
                        },
                    ]);
                    router.back();
                },
            },
        ]);
    };

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" numberOfLines={1} style={{ marginTop: theme.space.md }}>
                    {playlist.name}
                </Text>
                <Text variant="caption" color="textFaint" style={{ marginTop: 2, marginBottom: theme.space.md }}>
                    {songs.length} songs{playlist.isExploratory ? " · Audition" : ""}
                </Text>
                <View style={{ flexDirection: "row", gap: theme.space.sm, marginBottom: theme.space.md }}>
                    <Button label="Play" icon="play" onPress={playPlaylist} style={{ flex: 1 }} />
                    <Button label="Download" icon="download-outline" variant="ghost" onPress={downloadPlaylist} style={{ flex: 1 }} />
                    <Button label="Delete" icon="trash-outline" variant="ghost" onPress={confirmDelete} />
                </View>
                <TextField
                    placeholder="Search in playlist"
                    onChangeText={filterSongs}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ marginBottom: theme.space.md }}
                />
                <SongList
                    songs={filteredSongs}
                    onSelectSong={handleSelectSong}
                    onShowInfo={(s) => router.push({ pathname: "/song/[id]", params: { id: s.song.songId } })}
                />
            </View>
            <PlayerBar />
        </Screen>
    );
}
