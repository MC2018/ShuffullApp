import { FlatList } from "react-native";
import React from "react";
import { SongDetails } from "@/app/services/db/types";
import { IconButton, ListRow } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

interface SongListProps {
    songs: SongDetails[];
    onSelectSong: (songInfo: SongDetails) => void;
    // When provided, each row shows an info button that opens song details without playing.
    onShowInfo?: (songInfo: SongDetails) => void;
}

export function SongList({ songs, onSelectSong, onShowInfo }: SongListProps) {
    const theme = useTheme();
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
                    right={
                        onShowInfo ? (
                            <IconButton
                                name="information-circle-outline"
                                size={22}
                                color={theme.color.textFaint}
                                onPress={() => onShowInfo(item)}
                                accessibilityLabel="Song info"
                            />
                        ) : undefined
                    }
                />
            )}
        />
    );
}
