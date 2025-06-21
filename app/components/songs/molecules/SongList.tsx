import { View, Text, FlatList, TextInput } from "react-native";
import React from "react";
import { SongDetails } from "@/app/services/db/queries";

interface SongListProps {
    songs: SongDetails[],
    onSelectSong: (songInfo: SongDetails) => void;
};

export function SongList({ songs, onSelectSong }: SongListProps) {
    return (
        <FlatList data={songs} renderItem={({ item }) => 
            <View style={{margin: 5}} onTouchEnd={() => onSelectSong(item)}>
                <Text style={{fontSize: 18}}>{item.song.name}</Text>
                <Text>
                    {item.artists.length > 0 ? item.artists.map(x => x.name).join(", ") : "Unknown Artist"}
                </Text>
            </View>
        } />
    );
}
