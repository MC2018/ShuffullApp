import { useCallback, useEffect, useState } from "react";
import { Platform, ScrollView, Switch, View } from "react-native";
import { router } from "expo-router";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import DbQueries from "@/app/services/db/queries";
import { AutoDownloader } from "@/app/services/downloader/autoDownloader";
import { AUTO_DOWNLOAD_TIERS, AutoDownloadTier } from "@/app/tools/autoDownloads";
import { IconButton, ListRow, Screen, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { MediaManager } from "@/app/services/media-manager";
import { usePrefetchSetting } from "@/app/services/prefetch/prefetchSetting";
import { prefetcher } from "@/app/services/prefetch/Prefetcher";
import { PREFETCH_CACHE_CAP_BYTES } from "@/app/tools/prefetchCache";

const CAP_MB = Math.round(PREFETCH_CACHE_CAP_BYTES / 1024 / 1024);

// App settings: "Load upcoming songs ahead" (ShuffullApp#124), which fetches the next song or two while the current
// one plays so a skip starts at once, and the list of songs hidden as duplicates (ShuffullApp#219). Development builds
// also get a Developer section that opens the December recap (ShuffullApp#116) at any time of year, and drives the
// auto-download engine (ShuffullApp#225) until its real settings screen lands (ShuffullApp#226).
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

                <Text variant="label" color="textMuted" style={{ marginTop: theme.space.lg }}>Library</Text>
                <ListRow
                    title="Hidden duplicates"
                    subtitle="Songs you reported as a duplicate or a version you don't want. Undo brings one back."
                    onPress={() => router.push("/hidden-duplicates")}
                />

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
                        <AutoDownloadsDevRows />
                    </>
                ) : null}
            </ScrollView>
        </Screen>
    );
}

// Developer-only stand-in for the auto-downloads settings (ShuffullApp#226 builds the real screen). Tap the tier to
// step through the ladder; "Run now" runs one pass with the usual 10-minute hold; "Run now, no delay" acts at once.
function AutoDownloadsDevRows() {
    const db = useDb();
    const userId = useCurrentUser();
    const [tier, setTier] = useState<AutoDownloadTier | undefined>();
    const [status, setStatus] = useState("");

    const refresh = useCallback(async () => {
        setTier((await DbQueries.getAutoDownloadSettings(db, userId)).tier);
        const pending = await DbQueries.countAutoDownloadPending(db);
        const last = AutoDownloader.shared(db).lastResult;
        setStatus(
            `Waiting: ${pending.add} to add, ${pending.remove} to remove.` +
            (last ? ` Last run ${new Date(last.atMs).toLocaleTimeString()}: queued ${last.enqueued}, removed ${last.removed}.` : " No run yet."),
        );
    }, [db, userId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const nextTier = async () => {
        const next = AUTO_DOWNLOAD_TIERS[(AUTO_DOWNLOAD_TIERS.indexOf(tier ?? "off") + 1) % AUTO_DOWNLOAD_TIERS.length];
        await DbQueries.saveAutoDownloadSettings(db, userId, { tier: next });
        await refresh();
    };

    const runNow = async (delayMs?: number) => {
        await AutoDownloader.shared(db).run({ delayMs });
        await refresh();
    };

    return (
        <>
            <ListRow title={`Auto-download tier: ${tier ?? "…"}`} subtitle={status} onPress={() => void nextTier()} />
            <ListRow title="Run auto-downloads now" subtitle="Changes still wait 10 minutes." onPress={() => void runNow()} />
            <ListRow title="Run auto-downloads now, no delay" subtitle="Acts on every difference at once." onPress={() => void runNow(0)} />
        </>
    );
}
