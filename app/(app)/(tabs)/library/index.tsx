import React, { useCallback, useEffect } from "react";
import { Alert, ScrollView, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { GenreJam, Playlist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import { jamSummary, launchJam } from "@/app/services/genre-jam";
import { AlbumArt, Divider, IconButton, ListRow, Screen, SectionHeader, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

export default function LibraryScreen() {
    const [playlists, setPlaylists] = React.useState<Playlist[]>([]);
    const [jams, setJams] = React.useState<GenreJam[]>([]);
    const userId = useCurrentUser();
    const db = useDb();
    const theme = useTheme();

    useEffect(() => {
        (async () => {
            setPlaylists(await DbQueries.getPlaylists(db, userId));
        })();
    }, [userId]);

    const loadJams = useCallback(async () => {
        setJams(await DbQueries.getGenreJams(db));
    }, [db]);

    // Reload jams on focus so a newly-saved or deleted jam shows up immediately.
    useFocusEffect(
        useCallback(() => {
            loadJams();
        }, [loadJams]),
    );

    const confirmDelete = (jam: GenreJam) => {
        Alert.alert("Delete jam", `Delete "${jam.name}"?`, [
            { text: "Cancel", style: "cancel" },
            {
                text: "Delete",
                style: "destructive",
                onPress: async () => {
                    await DbQueries.deleteGenreJam(db, jam.genreJamId);
                    loadJams();
                },
            },
        ]);
    };

    const chevron = <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />;
    const jamSwatch = (
        <View style={{ width: 48, height: 48, borderRadius: theme.radius.md, backgroundColor: theme.color.accentWash, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="play" size={20} color={theme.color.accent} />
        </View>
    );

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" style={{ marginTop: theme.space.md, marginBottom: theme.space.sm }}>
                    Library
                </Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                    <ListRow
                        title="Downloads"
                        subtitle="Saved offline"
                        onPress={() => router.push("/library/downloads")}
                        left={
                            <View style={{ width: 48, height: 48, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                                <Ionicons name="download-outline" size={22} color={theme.color.textMuted} />
                            </View>
                        }
                        right={chevron}
                    />

                    <Divider style={{ marginVertical: theme.space.sm }} />
                    <SectionHeader title="Jams" actionLabel="New" onAction={() => router.push("/genre-jam")} />
                    {jams.length === 0 ? (
                        <Text variant="body" color="textFaint">
                            No jams yet — tap New to make one.
                        </Text>
                    ) : (
                        jams.map((jam) => (
                            <ListRow
                                key={jam.genreJamId}
                                title={jam.name}
                                subtitle={jamSummary(jam)}
                                left={jamSwatch}
                                right={
                                    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.xs }}>
                                        <IconButton
                                            name="create-outline"
                                            size={20}
                                            color={theme.color.textFaint}
                                            onPress={() => router.push({ pathname: "/genre-jam", params: { id: jam.genreJamId } })}
                                            accessibilityLabel="Edit jam"
                                        />
                                        <IconButton name="trash-outline" size={20} color={theme.color.textFaint} onPress={() => confirmDelete(jam)} accessibilityLabel="Delete jam" />
                                    </View>
                                }
                                onPress={() => launchJam(jam)}
                            />
                        ))
                    )}

                    <Divider style={{ marginVertical: theme.space.sm }} />
                    <SectionHeader title="Playlists" />
                    {playlists.length === 0 ? (
                        <Text variant="body" color="textFaint">
                            No playlists yet.
                        </Text>
                    ) : (
                        playlists.map((p) => (
                            <ListRow
                                key={p.playlistId}
                                title={p.name}
                                subtitle="Playlist"
                                left={<AlbumArt size={48} radius={theme.radius.md} />}
                                right={chevron}
                                onPress={() => router.push({ pathname: "/library/playlist/[id]", params: { id: p.playlistId } })}
                            />
                        ))
                    )}
                </ScrollView>
            </View>
            <PlayerBar />
        </Screen>
    );
}
