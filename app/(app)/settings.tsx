import React from "react";
import { ScrollView, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { ListRow, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { MediaManager } from "@/app/services/media-manager";
import { usePrefetchSetting } from "@/app/services/prefetch/prefetchSetting";
import { prefetcher } from "@/app/services/prefetch/Prefetcher";

// App settings. Right now: "Load upcoming songs ahead" (ShuffullApp#124), which fetches the next song or two while
// the current one plays so a skip starts at once.
export default function SettingsScreen() {
    const theme = useTheme();
    const enabled = usePrefetchSetting((state) => state.enabled);
    const loaded = usePrefetchSetting((state) => state.loaded);

    return (
        <Screen>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md, marginBottom: theme.space.md }}>
                <Ionicons name="chevron-back" size={24} color={theme.color.textPrimary} onPress={() => router.back()} />
                <Text variant="screenTitle">Settings</Text>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: theme.space.sm }}>
                <Text variant="label" color="textMuted">Playback</Text>
                {prefetcher.supported ? (
                    <>
                        <ListRow
                            title="Load upcoming songs ahead"
                            subtitle="Skips start instantly. Uses data, mobile included."
                            onPress={loaded ? () => MediaManager.setPrefetchUpcoming(!enabled) : undefined}
                            right={
                                <Switch
                                    value={enabled}
                                    disabled={!loaded}
                                    onValueChange={(value) => MediaManager.setPrefetchUpcoming(value)}
                                    trackColor={{ true: theme.color.accent }}
                                    accessibilityLabel="Load upcoming songs ahead"
                                />
                            }
                        />
                        <Text variant="caption" color="textFaint">
                            Fetches the next one or two songs while the current one plays, up to about 100 MB. They are
                            not downloads: they are deleted once played and never show in your library.
                        </Text>
                    </>
                ) : (
                    <Text variant="body" color="textMuted">
                        Loading upcoming songs ahead is not available on this platform yet.
                    </Text>
                )}
            </ScrollView>
        </Screen>
    );
}
