import React from "react";
import { View } from "react-native";
import { MediaManager } from "@/app/services/media-manager";
import { useIsPlaybackActive } from "@/app/services/media-manager/mediaManager";
import { useTheme } from "@/app/theme";
import IconButton from "@/app/components/ui/IconButton";

// Previous / play-pause / next. The play-pause glyph reflects live playback state; the toggle itself
// re-checks MediaManager so it stays correct even if the state hook is mid-transition. Both use the same rule, so a
// stalled song shows "pause" and pausing it actually stops it.
export default function Transport() {
    const theme = useTheme();
    const isPlaying = useIsPlaybackActive();

    const toggle = async () => {
        await MediaManager.togglePlayback();
    };

    return (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: theme.space.xxl }}>
            <IconButton name="play-skip-back" size={26} onPress={() => MediaManager.previous()} accessibilityLabel="Previous" />
            <IconButton
                name={isPlaying ? "pause" : "play"}
                size={28}
                filled
                round={64}
                onPress={toggle}
                accessibilityLabel={isPlaying ? "Pause" : "Play"}
            />
            <IconButton name="play-skip-forward" size={26} onPress={() => MediaManager.skip()} accessibilityLabel="Next" />
        </View>
    );
}
