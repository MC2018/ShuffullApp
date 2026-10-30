import { useCallback, useState } from "react";
import { FlatList, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DbQueries from "@/app/services/db/queries";
import { ListenStatsSnapshot, MaybeDropSong } from "@/app/services/db/queries/listenStats";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import { ListRow, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { describeAgo, describeMaybeDropRule, describeQuickSkips } from "@/app/tools/listenStats";

// Library › Maybe drop this (ShuffullApp#115): songs the server flagged because you keep skipping them early. A list
// to look at, nothing more: it changes no like, playlist or shuffle. Each row opens the song, where you can dislike it
// or take it off a playlist yourself. Read from the last synced stats, so it works offline.
export default function MaybeDropScreen() {
    const theme = useTheme();
    const db = useDb();
    const userId = useCurrentUser();
    const [songs, setSongs] = useState<MaybeDropSong[]>([]);
    const [snapshot, setSnapshot] = useState<ListenStatsSnapshot | null>(null);
    const [loaded, setLoaded] = useState(false);

    // On focus, so a song disliked on its screen is gone on the way back.
    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            (async () => {
                const [flagged, synced] = await Promise.all([
                    DbQueries.getMaybeDropSongs(db, userId),
                    DbQueries.getListenStatsSnapshot(db, userId),
                ]);
                if (!cancelled) {
                    setSongs(flagged);
                    setSnapshot(synced);
                    setLoaded(true);
                }
            })();
            return () => {
                cancelled = true;
            };
        }, [db, userId]),
    );

    const chevron = <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />;

    let emptyText = "Nothing here. No song has been skipped early often enough to flag.";
    if (snapshot == null) {
        emptyText = "Your listening stats haven't synced yet. They appear here once the server has them.";
    }

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <Text variant="screenTitle" style={{ marginTop: theme.space.md, marginBottom: theme.space.xs }}>
                    Maybe drop this
                </Text>
                {snapshot != null ? (
                    <Text variant="caption" color="textMuted" style={{ marginBottom: theme.space.md }}>
                        {describeMaybeDropRule(snapshot.rule)} Nothing changes on its own: open a song to dislike it or
                        remove it. Updated {describeAgo(snapshot.syncedAt, new Date())}.
                    </Text>
                ) : (
                    <View style={{ height: theme.space.md }} />
                )}
                <FlatList
                    data={songs}
                    keyExtractor={(item) => item.song.songId}
                    showsVerticalScrollIndicator={false}
                    ListEmptyComponent={
                        loaded ? (
                            <Text variant="body" color="textFaint">
                                {emptyText}
                            </Text>
                        ) : null
                    }
                    renderItem={({ item }) => (
                        <ListRow
                            title={item.song.name}
                            subtitle={
                                (snapshot != null ? `${describeQuickSkips(item.stat, snapshot.rule)} · ` : "") +
                                (item.artists.length > 0 ? item.artists.map((x) => x.name).join(", ") : "Unknown Artist")
                            }
                            right={chevron}
                            onPress={() => router.push({ pathname: "/song/[id]", params: { id: item.song.songId } })}
                        />
                    )}
                />
            </View>
            <PlayerBar />
        </Screen>
    );
}
