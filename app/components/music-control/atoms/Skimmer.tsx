import React from "react";
import { View } from "react-native";
import { useProgress } from "react-native-track-player";
import Slider from "@react-native-community/slider";
import { MediaManager } from "@/app/services/media-manager";
import { useTheme } from "@/app/theme";
import Text from "@/app/components/ui/Text";

function fmt(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) {
        seconds = 0;
    }
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

interface Props {
    showTimes?: boolean;
}

// TODO: this is not a proper atom, it's calling MediaManager directly
export default function Skimmer({ showTimes = false }: Props) {
    const theme = useTheme();
    const { position, duration } = useProgress();

    const handleSlidingComplete = async (value: number) => {
        await MediaManager.seekTo(value);
    };

    return (
        <View style={{ width: "100%" }}>
            <Slider
                style={{ width: "100%", height: 32 }}
                minimumValue={0}
                maximumValue={duration > 0 ? duration : 1}
                value={position}
                onSlidingComplete={handleSlidingComplete}
                minimumTrackTintColor={theme.color.accent}
                maximumTrackTintColor={theme.color.line}
                thumbTintColor={theme.color.accent}
            />
            {showTimes ? (
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: -2 }}>
                    <Text variant="caption" color="textFaint">
                        {fmt(position)}
                    </Text>
                    <Text variant="caption" color="textFaint">
                        {fmt(duration)}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}
