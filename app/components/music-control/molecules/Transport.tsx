import { View } from "react-native";
import { MediaManager } from "@/app/services/media-manager";
import { useIsPlaybackActive } from "@/app/services/media-manager/mediaManager";
import { useTheme } from "@/app/theme";
import IconButton from "@/app/components/ui/IconButton";

// Previous / play-pause / next. The play-pause glyph reflects live playback state; the toggle itself
// re-checks MediaManager so it stays correct even if the state hook is mid-transition. Both use the same rule, so a
// stalled song shows "pause" and pausing it actually stops it.
// `compact` is the smaller version that sits above the inline progress bar in the desktop control bar (ShuffullApp#217).
export default function Transport({ compact = false }: { compact?: boolean }) {
    const theme = useTheme();
    const isPlaying = useIsPlaybackActive();

    const toggle = async () => {
        await MediaManager.togglePlayback();
    };

    return (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: compact ? theme.space.xl : theme.space.xxl }}>
            <IconButton name="play-skip-back" size={compact ? 22 : 26} onPress={() => MediaManager.previous()} accessibilityLabel="Previous" />
            <IconButton
                name={isPlaying ? "pause" : "play"}
                size={compact ? 22 : 28}
                filled
                round={compact ? 44 : 64}
                onPress={toggle}
                accessibilityLabel={isPlaying ? "Pause" : "Play"}
            />
            <IconButton name="play-skip-forward" size={compact ? 22 : 26} onPress={() => MediaManager.skip()} accessibilityLabel="Next" />
        </View>
    );
}
