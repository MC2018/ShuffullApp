import { Text, TextInput, View } from "react-native";
import { useEffect, useState } from "react";
import { useDb } from "@/app/services/db/DbProvider";
import DbQueries from "@/app/services/db/queries";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { SongList } from "@/app/components/songs/molecules/SongList";
import { SongDetails } from "@/app/services/db/types";
import { MediaManager } from "@/app/services/media-manager";

export default function SongsScreen() {
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
    };

    return (
        <>
            <View
                style={{
                    flex: 1,
                    paddingBottom: totalPlayerBarHeight,
                }}>
                <Text style={{ fontSize: 24, marginBottom: 20 }}>Songs</Text>
                <TextInput placeholder="Search" onChangeText={filterSongs}></TextInput>
                <SongList songs={filteredSongs} onSelectSong={handleSelectSong} />
            </View>
            <PlayerBar></PlayerBar>
        </>
    );
}
