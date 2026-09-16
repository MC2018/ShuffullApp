import { View } from "react-native";
import { useEffect, useState } from "react";
import { router } from "expo-router";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import { SongDetails } from "@/app/services/db/types";
import { MediaManager } from "@/app/services/media-manager";
import { Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

export default function SongsScreen() {
    const theme = useTheme();
    const [songs, setSongs] = useState<SongDetails[]>([]);
    const [filteredSongs, setFilteredSongs] = useState<SongDetails[]>([]);
    const db = useDb();

    useEffect(() => {
        (async () => {
            const all = await DbQueries.getAllSongDetails(db);
            setSongs(all);
            setFilteredSongs(all);
        })();
    }, []);

    const handleSelectSong = async (songInfo: SongDetails) => {
        await MediaManager.playSpecificSong(songInfo.song.songId);
    };

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

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" style={{ marginTop: theme.space.md, marginBottom: theme.space.md }}>
                    Songs
                </Text>
                <TextField
                    placeholder="Search songs or artists"
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
