import { FlatList } from "react-native";
import React from "react";
import { SongDetails } from "@/app/services/db/types";
import { ListRow } from "@/app/components/ui";

interface SongListProps {
    songs: SongDetails[];
    onSelectSong: (songInfo: SongDetails) => void;
}

export function SongList({ songs, onSelectSong }: SongListProps) {
    return (
        <FlatList
            data={songs}
            keyExtractor={(item) => item.song.songId}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => (
                <ListRow
                    title={item.song.name}
                    subtitle={item.artists.length > 0 ? item.artists.map((x) => x.name).join(", ") : "Unknown Artist"}
                    onPress={() => onSelectSong(item)}
                />
            )}
        />
    );
}
