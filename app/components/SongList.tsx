import { View, Text, FlatList, TextInput } from "react-native";
import { useDb } from "../services/db/DbProvider";
import { useEffect, useState } from "react";
import * as DbQueries from "../services/db/queries";
import { MediaManager } from "../tools";
import React from "react";
import PlayerBar, { totalPlayerBarHeight } from "../components/PlayerBar";

interface SongListProps {
    songs: DbQueries.SongDetails[],
    onSelectSong: (songInfo: DbQueries.SongDetails) => void;
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
