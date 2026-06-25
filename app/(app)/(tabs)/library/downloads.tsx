import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import DbQueries from "@/app/services/db/queries";
import { useDb } from "@/app/services/db/DbProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import { SongDetails } from "@/app/services/db/types";
import { MediaManager } from "@/app/services/media-manager";
import { Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

export default function LocalDownloadsScreen() {
    const theme = useTheme();
    const [songs, setSongs] = useState<SongDetails[]>([]);
    const [filteredSongs, setFilteredSongs] = useState<SongDetails[]>([]);
    const db = useDb();

    useEffect(() => {
        (async () => {
            const dbSongs = await DbQueries.getDownloadedSongDetails(db);
            setSongs(dbSongs);
            setFilteredSongs(dbSongs);
        })();
    }, []);

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

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" style={{ marginTop: theme.space.md, marginBottom: theme.space.md }}>
                    Downloads
                </Text>
                <TextField
                    placeholder="Search downloads"
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
