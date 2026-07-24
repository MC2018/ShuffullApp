import { FlatList, View } from "react-native";
import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { SongDetails } from "@/app/services/db/types";
import { IconButton, ListRow } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { AuditionRowState } from "@/app/tools/audition";

interface SongListProps {
    songs: SongDetails[];
    onSelectSong: (songInfo: SongDetails) => void;
    // When provided, each row shows an info button that opens song details without playing.
    onShowInfo?: (songInfo: SongDetails) => void;
    // When provided, AUDITION rows show a bookmark: "keep this song without liking it" — it stays in the
    // library with cheap (weak-model) tags instead of dying with the audition playlist. Liking remains the
    // premium exit; Keep is the budget one.
    onKeepSong?: (songInfo: SongDetails) => void;
    // Per-song audition states (playlist screens pass these for audition cohorts). Drives the three-state
    // row treatment: unheard = accent dot ("needs its chance"), heard/disliked = dimmed (dies with the
    // cohort), kept = bookmark glyph, liked = heart glyph. Absent = plain rows, as everywhere else.
    auditionStates?: Record<string, AuditionRowState>;
}

export function SongList({ songs, onSelectSong, onShowInfo, onKeepSong, auditionStates }: SongListProps) {
    const theme = useTheme();
    return (
        <FlatList
            data={songs}
            keyExtractor={(item) => item.song.songId}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => {
                const state = auditionStates?.[item.song.songId];
                return (
                    <ListRow
                        title={item.song.name}
                        // Outside audition views the subtitle prefix is the only audition marker; inside them
                        // the dot/dim/glyph treatment carries it, so the prefix stays for consistency either way.
                        subtitle={
                            (item.song.exploratory ? "Audition · " : "") +
                            (item.artists.length > 0 ? item.artists.map((x) => x.name).join(", ") : "Unknown Artist")
                        }
                        onPress={() => onSelectSong(item)}
                        // Heard-but-undecided (and disliked) rows recede — they die with the cohort unless acted on.
                        style={state === "heard" ? { opacity: 0.45 } : undefined}
                        left={
                            auditionStates ? (
                                // Fixed-width slot keeps titles aligned; the dot renders only while unheard.
                                <View style={{ width: 10, alignItems: "center" }}>
                                    {state === "unheard" ? (
                                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.accent }} />
                                    ) : null}
                                </View>
                            ) : undefined
                        }
                        right={
                            <View style={{ flexDirection: "row", alignItems: "center" }}>
                                {state === "kept" ? (
                                    <Ionicons name="bookmark" size={18} color={theme.color.accent} style={{ marginRight: 6 }} />
                                ) : null}
                                {state === "liked" ? (
                                    <Ionicons name="heart" size={18} color={theme.color.accent} style={{ marginRight: 6 }} />
                                ) : null}
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
                        }
                    />
                );
            }}
        />
    );
}
