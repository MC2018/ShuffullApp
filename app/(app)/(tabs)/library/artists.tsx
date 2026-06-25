import React, { useCallback, useState } from "react";
import { FlatList, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DbQueries from "@/app/services/db/queries";
import { ArtistWithCount } from "@/app/services/db/queries/artist";
import { useDb } from "@/app/services/db/DbProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { ListRow, Screen, Text, TextField } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

export default function ArtistsScreen() {
    const theme = useTheme();
    const db = useDb();
    const [artists, setArtists] = useState<ArtistWithCount[]>([]);
    const [query, setQuery] = useState("");

    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            (async () => {
                const all = await DbQueries.getArtistsWithCounts(db);
                if (!cancelled) {
                    setArtists(all);
                }
            })();
            return () => {
                cancelled = true;
            };
        }, [db]),
    );

    const q = query.trim().toLowerCase();
    const filtered = q === "" ? artists : artists.filter((a) => a.name.toLowerCase().includes(q));

    const chevron = <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />;

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" style={{ marginTop: theme.space.md, marginBottom: theme.space.md }}>
                    Artists
                </Text>
                <TextField
                    placeholder="Search artists"
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ marginBottom: theme.space.md }}
                />
                <FlatList
                    data={filtered}
                    keyExtractor={(item) => item.artistId}
                    showsVerticalScrollIndicator={false}
                    ListEmptyComponent={
                        <Text variant="body" color="textFaint">
                            No artists yet.
                        </Text>
                    }
                    renderItem={({ item }) => (
                        <ListRow
                            title={item.name}
                            subtitle={`${item.songCount} song${item.songCount === 1 ? "" : "s"}`}
                            left={
                                <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.color.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                                    <Ionicons name="person" size={22} color={theme.color.textMuted} />
                                </View>
                            }
                            right={chevron}
                            onPress={() => router.push({ pathname: "/artist/[id]", params: { id: item.artistId } })}
                        />
                    )}
                />
            </View>
            <PlayerBar />
        </Screen>
    );
}
