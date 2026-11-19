import { useMemo } from "react";
import { SectionList, View } from "react-native";
import { router } from "expo-router";
import PlayerBar, { totalPlayerBarHeight } from "@/app/components/music-control/organisms/PlayerBar";
import PlayHistoryRow from "@/app/components/history/PlayHistoryRow";
import { usePlayHistory } from "@/app/components/history/usePlayHistory";
import { IconButton, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { groupPlaysByDay, PLAY_HISTORY_LIMIT } from "@/app/tools/playHistory";

// Recently played: every song this device played, newest first, one heading per day. The player's own back/forward
// list is wiped when a new playlist or audition starts; this isn't, so the song from two playlists ago is still here.
// Each row opens the song. The song playing now is in the player bar below, not in the list: a row appears once its
// play ends.
export default function HistoryScreen() {
    const theme = useTheme();
    const { plays, loaded } = usePlayHistory();
    // `plays` is a new array on every reload, and a reload is when "today" can have moved on.
    const sections = useMemo(() => groupPlaysByDay(plays, (x) => x.play.startedAt, new Date()), [plays]);

    return (
        <Screen>
            <View style={{ flex: 1, paddingBottom: totalPlayerBarHeight }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md, marginBottom: theme.space.xs }}>
                    <IconButton name="chevron-back" size={24} color={theme.color.textPrimary} onPress={() => router.back()} accessibilityLabel="Back" />
                    <Text variant="screenTitle">Recently played</Text>
                </View>
                <Text variant="caption" color="textMuted" style={{ marginBottom: theme.space.sm }}>
                    The last {PLAY_HISTORY_LIMIT} songs played on this device. Tap one to open it.
                </Text>
                <SectionList
                    style={{ flex: 1 }}
                    sections={sections}
                    keyExtractor={(item) => item.play.listenId}
                    showsVerticalScrollIndicator={false}
                    stickySectionHeadersEnabled={false}
                    renderSectionHeader={({ section }) => (
                        <Text variant="section" style={{ marginTop: theme.space.lg, marginBottom: theme.space.xs }}>
                            {section.title}
                        </Text>
                    )}
                    renderItem={({ item }) => <PlayHistoryRow item={item} />}
                    ListEmptyComponent={
                        loaded ? (
                            <Text variant="body" color="textFaint" style={{ marginTop: theme.space.lg }}>
                                Nothing yet. Songs show up here once they finish or you skip past them.
                            </Text>
                        ) : null
                    }
                />
            </View>
            <PlayerBar />
        </Screen>
    );
}
