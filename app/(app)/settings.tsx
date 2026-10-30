import { Platform, ScrollView, Switch, View } from "react-native";
import { router } from "expo-router";
import { IconButton, ListRow, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { MediaManager } from "@/app/services/media-manager";
import { usePrefetchSetting } from "@/app/services/prefetch/prefetchSetting";
import { prefetcher } from "@/app/services/prefetch/Prefetcher";
import { PREFETCH_CACHE_CAP_BYTES } from "@/app/tools/prefetchCache";

const CAP_MB = Math.round(PREFETCH_CACHE_CAP_BYTES / 1024 / 1024);

// App settings. Right now: "Load upcoming songs ahead" (ShuffullApp#124), which fetches the next song or two while
// the current one plays so a skip starts at once. Development builds also get a Developer section that opens the
// December recap (ShuffullApp#116) at any time of year.
export default function SettingsScreen() {
    const theme = useTheme();
    const enabled = usePrefetchSetting((state) => state.enabled);
    const loaded = usePrefetchSetting((state) => state.loaded);

    return (
        <Screen>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md, marginBottom: theme.space.md }}>
                <IconButton name="chevron-back" size={24} color={theme.color.textPrimary} onPress={() => router.back()} accessibilityLabel="Back" />
                <Text variant="screenTitle">Settings</Text>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: theme.space.sm }}>
                <Text variant="label" color="textMuted">Playback</Text>
                {prefetcher.supported ? (
                    <>
                        <ListRow
                            title="Load upcoming songs ahead"
                            subtitle={Platform.OS === "web" ? "Skips start instantly." : "Skips start instantly. Uses data, mobile included."}
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
                            Fetches the next one or two songs while the current one plays, up to about {CAP_MB} MB. They are
                            not downloads: they are deleted once played and never show in your library.
                        </Text>
                    </>
                ) : (
                    <Text variant="body" color="textMuted">
                        Loading upcoming songs ahead is not available on this platform yet.
                    </Text>
                )}

                {__DEV__ ? (
                    <>
                        <Text variant="label" color="textMuted" style={{ marginTop: theme.space.lg }}>Developer</Text>
                        <ListRow
                            title="Open the recap"
                            subtitle="This year's, from the server. Home shows it only in December."
                            onPress={() => router.push("/recap")}
                        />
                        <ListRow
                            title="Open the recap with sample data"
                            subtitle="Made-up numbers, no server."
                            onPress={() => router.push("/recap?sample=1")}
                        />
                    </>
                ) : null}
            </ScrollView>
        </Screen>
    );
}
