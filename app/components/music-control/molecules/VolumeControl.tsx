import { useEffect, useRef } from "react";
import { View } from "react-native";
import Slider from "@react-native-community/slider";
import { setSystemVolume, setVolumeDragging, toggleSystemMute, useSystemVolume, useSystemVolumeStore } from "@/app/services/systemVolume";
import { volumeAfterKey, volumeAfterWheel, volumeGlyph } from "@/app/tools/volume";
import IconButton from "@/app/components/ui/IconButton";
import Text from "@/app/components/ui/Text";
import { useTheme } from "@/app/theme";

interface Props {
    /** Width of the slider track. */
    width?: number;
    /** Show the level as a percentage after the slider. */
    showPercent?: boolean;
}

/**
 * Mute button + slider for the speaker Shuffull plays on (ShuffullApp#217). The same control in the player bar and
 * on Now Playing; both read one shared level, so moving either moves the other, and the system Sound settings move
 * them too.
 *
 * Renders nothing outside the desktop app, or where the shell has no speaker to control.
 *
 * The web slider has no keyboard handling of its own, so arrow keys / PageUp / PageDown / Home / End and the scroll
 * wheel are wired here, on the DOM node react-native-web renders for the wrapper. That listener is only attached on
 * web, which is the only place this ever renders.
 */
export default function VolumeControl({ width = 112, showPercent = true }: Props) {
    const theme = useTheme();
    const state = useSystemVolume();
    const wrapper = useRef<View>(null);

    const available = state.available;
    useEffect(() => {
        const node = wrapper.current as unknown as HTMLElement | null;
        if (!available || !node || typeof node.addEventListener !== "function") {return;}
        const current = () => {
            const s = useSystemVolumeStore.getState().state;
            return s.available ? s.volume : 0;
        };
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            setSystemVolume(volumeAfterWheel(current(), e.deltaY));
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "m" || e.key === "M") {
                e.preventDefault();
                toggleSystemMute();
                return;
            }
            const next = volumeAfterKey(current(), e.key);
            if (next == null) {return;}
            e.preventDefault();
            setSystemVolume(next);
        };
        node.tabIndex = 0;
        node.addEventListener("wheel", onWheel, { passive: false });
        node.addEventListener("keydown", onKey);
        return () => {
            node.removeEventListener("wheel", onWheel);
            node.removeEventListener("keydown", onKey);
        };
    }, [available]);

    if (!state.available) {
        return null;
    }

    const silent = state.muted || state.volume === 0;
    const label = state.muted ? "Muted" : `${state.volume}%`;

    return (
        <View
            ref={wrapper}
            accessibilityRole="adjustable"
            accessibilityLabel={`Volume, ${label}, ${state.device}`}
            style={{ flexDirection: "row", alignItems: "center", gap: theme.space.xs }}
        >
            <IconButton
                name={volumeGlyph(state.volume, state.muted)}
                size={20}
                color={theme.color.textMuted}
                onPress={toggleSystemMute}
                accessibilityLabel={state.muted ? "Unmute" : "Mute"}
            />
            <Slider
                style={{ width, height: 24 }}
                minimumValue={0}
                maximumValue={100}
                step={1}
                value={state.volume}
                onSlidingStart={() => setVolumeDragging(true)}
                onValueChange={setSystemVolume}
                onSlidingComplete={(v) => {
                    setSystemVolume(v);
                    setVolumeDragging(false);
                }}
                minimumTrackTintColor={silent ? theme.color.textFaint : theme.color.textPrimary}
                maximumTrackTintColor={theme.color.lineStrong}
                thumbTintColor={silent ? theme.color.textFaint : theme.color.textPrimary}
            />
            {showPercent ? (
                <Text variant="caption" color={silent ? "textFaint" : "textMuted"} style={{ minWidth: 40, textAlign: "right", fontVariant: ["tabular-nums"] }}>
                    {label}
                </Text>
            ) : null}
        </View>
    );
}
