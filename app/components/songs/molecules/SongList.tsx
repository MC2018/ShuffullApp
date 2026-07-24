import { FlatList, View } from "react-native";
import React from "react";
import { SongDetails } from "@/app/services/db/types";
import { IconButton, ListRow } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

interface SongListProps {
    songs: SongDetails[];
    onSelectSong: (songInfo: SongDetails) => void;
    // When provided, each row shows an info button that opens song details without playing.
    onShowInfo?: (songInfo: SongDetails) => void;
    // When provided, AUDITION rows show a bookmark: "keep this song without liking it" — it stays in the
    // library with cheap (weak-model) tags instead of dying with the audition playlist. Liking remains the
    // premium exit; Keep is the budget one.
    onKeepSong?: (songInfo: SongDetails) => void;
}

export function SongList({ songs, onSelectSong, onShowInfo, onKeepSong }: SongListProps) {
    const theme = useTheme();
    return (
        <FlatList
            data={songs}
            keyExtractor={(item) => item.song.songId}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => (
                <ListRow
                    title={item.song.name}
                    // Audition songs arrive untagged; flag them so it's clear a keep/like decides their fate.
                    subtitle={
                        (item.song.exploratory ? "Audition · " : "") +
                        (item.artists.length > 0 ? item.artists.map((x) => x.name).join(", ") : "Unknown Artist")
                    }
                    onPress={() => onSelectSong(item)}
                    right={
                        onShowInfo || onKeepSong ? (
                            <View style={{ flexDirection: "row", alignItems: "center" }}>
                                {onKeepSong && item.song.exploratory ? (
                                    <IconButton
                                        name="bookmark-outline"
                                        size={22}
                                        color={theme.color.textFaint}
                                        onPress={() => onKeepSong(item)}
                                        accessibilityLabel="Keep song"
                                    />
                                ) : null}
                                {onShowInfo ? (
                                    <IconButton
                                        name="information-circle-outline"
                                        size={22}
                                        color={theme.color.textFaint}
                                        onPress={() => onShowInfo(item)}
                                        accessibilityLabel="Song info"
                                    />
                                ) : null}
                            </View>
                        ) : undefined
                    }
                />
            )}
        />
    );
}
