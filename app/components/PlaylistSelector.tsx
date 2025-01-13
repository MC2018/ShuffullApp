import { View, Text } from "react-native";
import * as DbExtensions from "../services/db/dbExtensions";
import { useDb } from "../services/db/dbProvider";
import React, { useEffect, useState } from "react";
import { Picker } from "@react-native-picker/picker";
import { StyleSheet } from "react-native";
import { Playlist } from "../services/db/models";

export interface PlaylistSelectorProps {
    userId: number;
    onPlaylistSelected: (playlist: Playlist | undefined) => void;
}

export default function PlaylistSelector({ userId, onPlaylistSelected }: PlaylistSelectorProps) {
    const db = useDb();
    const [ playlists, setPlaylists ] = useState<Playlist[]>([]);
    const [ selectedIndex, setSelectedIndex ] = useState<number | undefined>(undefined);

    const handleValueChange = (value: string, index: number) => {
        setSelectedIndex(index);

        if (playlists.length == 0) {
            onPlaylistSelected(undefined);
        } else {
            onPlaylistSelected(playlists[index]);
        }
    };

    useEffect(() => {
        ((async () => {
            const playlists = await DbExtensions.getPlaylists(db, userId);
            const currentPlaylistId = (await DbExtensions.getActiveLocalSessionData(db))?.currentPlaylistId;
            setPlaylists(playlists);

            const index = playlists.findIndex(playlist => playlist.playlistId == currentPlaylistId);
            setSelectedIndex(index == -1 ? undefined : index);
        }))();
    }, [userId]);
    
    return (
        <View>
            <Text>Select your Playlist</Text>
            <Picker
                selectedValue={(selectedIndex == undefined || playlists.length == 0)
                    ? "" : selectedIndex.toString()}
                onValueChange={handleValueChange}
                style={styles.picker}
                >
                    {playlists.map((playlist, index) => (
                        <Picker.Item
                            key={playlist.playlistId}
                            label={playlist.name}
                            value={index.toString()} />
                    ))}
                </Picker>
        </View>
    );
}

const styles = StyleSheet.create({
    picker: {
        width: 200,
        height: 50,
        backgroundColor: '#d0d0d0',
    }
});
