import React from "react";
import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, IconButton, Text } from "@/app/components/ui";
import { useTheme } from "@/app/theme";
import { useDownloader } from "@/app/services/downloader/DownloaderProvider";
import { describeDownloadStatus, DownloadPhase, WIFI_ONLY_NOTE } from "@/app/tools/downloadStatus";
import { useDownloadStatusView } from "../useDownloadStatusView";

// Glyph per phase, so the state is readable at a glance before the words are.
const PHASE_ICON: Record<DownloadPhase, keyof typeof Ionicons.glyphMap> = {
    idle: "checkmark-circle-outline",
    downloading: "cloud-download-outline",
    paused: "pause-circle-outline",
    "waiting-for-wifi": "wifi-outline",
    offline: "cloud-offline-outline",
    unsupported: "desktop-outline",
};

// The management surface for background downloads: what is happening, to which song, how far along, and
// the one control that matters (pause / resume). The Wi-Fi policy is written underneath so it never has
// to be discovered by watching nothing happen on mobile data.
export default function DownloadStatusCard() {
    const theme = useTheme();
    const downloader = useDownloader();
    const { status, currentName } = useDownloadStatusView();
    const { title, detail } = describeDownloadStatus(status, currentName);

    const active = status.phase === "downloading";
    const paused = status.phase === "paused";
    // Pause is only meaningful while there is something to pause; resume must always be reachable.
    const showControl = status.phase !== "unsupported" && (paused || status.queuedCount > 0);
    const iconColor = active ? theme.color.accent : status.phase === "idle" ? theme.color.positive : theme.color.textMuted;
    const progress = active && status.current ? status.current.progress : 0;

    return (
        <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.md }}>
                <View
                    style={{
                        width: 44,
                        height: 44,
                        borderRadius: theme.radius.md,
                        backgroundColor: active ? theme.color.accentWash : theme.color.surfaceAlt,
                        alignItems: "center",
                        justifyContent: "center",
                    }}
                >
                    <Ionicons name={PHASE_ICON[status.phase]} size={22} color={iconColor} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="bodyStrong" numberOfLines={1}>
                        {title}
                    </Text>
                    {detail ? (
                        <Text variant="caption" color="textMuted" numberOfLines={1} style={{ marginTop: 2 }}>
                            {detail}
                        </Text>
                    ) : null}
                </View>
                {showControl ? (
                    <IconButton
                        name={paused ? "play" : "pause"}
                        size={20}
                        filled
                        round={44}
                        onPress={() => (paused ? downloader?.resume() : downloader?.pause())}
                        accessibilityLabel={paused ? "Resume downloads" : "Pause downloads"}
                    />
                ) : null}
            </View>

            {active ? (
                <View
                    style={{
                        height: 4,
                        borderRadius: theme.radius.pill,
                        backgroundColor: theme.color.neutralFill,
                        marginTop: theme.space.md,
                        overflow: "hidden",
                    }}
                >
                    <View style={{ width: `${Math.round(progress * 100)}%`, height: "100%", backgroundColor: theme.color.accent }} />
                </View>
            ) : null}

            {status.phase !== "unsupported" ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: theme.space.md }}>
                    <Ionicons name="wifi" size={13} color={theme.color.textFaint} />
                    <Text variant="caption" color="textFaint">
                        {WIFI_ONLY_NOTE}
                        {paused ? " Paused downloads won't resume until you tap play." : ""}
                    </Text>
                </View>
            ) : null}
        </Card>
    );
}
