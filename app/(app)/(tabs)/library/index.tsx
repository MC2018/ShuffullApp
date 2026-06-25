import React, { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Playlist } from "@/app/services/db/models";
import DbQueries from "@/app/services/db/queries";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import { AlbumArt, Divider, ListRow, Screen, SectionHeader, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";

export default function LibraryScreen() {
    const [playlists, setPlaylists] = React.useState<Playlist[]>([]);
    const userId = useCurrentUser();
    const db = useDb();
    const theme = useTheme();

    useEffect(() => {
        (async () => {
            setPlaylists(await DbQueries.getPlaylists(db, userId));
        })();
    }, [userId]);

    const chevron = <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />;

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
