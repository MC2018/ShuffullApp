import { Text, View, StyleSheet } from "react-native";
import React, { useEffect } from "react";
import { router } from "expo-router";
import { Playlist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import PlayerBar from "@/app/components/music-control/organisms/PlayerBar";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import SongCollectionScrollView from "@/app/components/song-collection/molecules/SongCollectionScrollView";

export default function LibraryScreen() {
    const [ playlists, setPlaylists ] = React.useState<Playlist[]>([]);
    const userId = useCurrentUser();
    const db = useDb();

    useEffect(() => {
        (async () => {
            setPlaylists(await DbQueries.getPlaylists(db, userId));
        })();
    }, [userId]);

    const handleSelectPlaylist = async (playlist: Playlist) => {
        router.push({ pathname: "/library/playlist/[id]", params: { id: playlist.playlistId } });
    };

    return (
        <>
            <View>
                <Text style={styles.header}>Your Saved Playlists</Text>
                <SongCollectionScrollView playlists={playlists} onSelected={handleSelectPlaylist}></SongCollectionScrollView>
            </View>
            <PlayerBar></PlayerBar>
        </>
    );
}

const styles = StyleSheet.create({
    header: {
        fontSize: 20,
        fontWeight: "bold",
    }
});
