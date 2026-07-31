import React, { useEffect, useRef, useState } from "react";
import { Animated, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { MediaManager } from "@/app/services/media-manager";
import { useTheme } from "@/app/theme";

/**
 * "Keep" for an audition song: retain it with cheap tags instead of letting it die with the cohort. Sits
 * beside RatingControl and follows the same rules as its siblings — optimistic state, a tactile
 * micro-animation, and a glyph that changes so the result is visible.
 *
 * ONE-WAY on purpose. There is no un-keep: MediaManager.keepSong enqueues a weak re-tag and clears the
 * audition flag, and nothing reverses that. So once kept, the control shows a filled bookmark and stops
 * responding rather than pretending to toggle. (Liking it afterwards is still the upgrade path.)
 *
 * The bookmark stays on screen after keeping instead of vanishing: disappearing is ambiguous — it reads the
 * same as a mis-tap that dismissed something.
 */
export default function KeepControl({
    songId,
    alreadyKept = false,
    size = 26,
    style,
}: {
    songId: string;
    /** True when the song has already left the audition state (kept or promoted). */
    alreadyKept?: boolean;
    size?: number;
    style?: React.ComponentProps<typeof Animated.View>["style"];
}) {
    const theme = useTheme();
    const [kept, setKept] = useState(alreadyKept);
    const scale = useRef(new Animated.Value(1)).current;

    // A new song gets a fresh control; without this the previous song's "kept" state would carry over and the
    // next audition song would look already-handled.
    useEffect(() => {
        setKept(alreadyKept);
        scale.setValue(1);
    }, [songId, alreadyKept, scale]);

    const pop = () =>
        Animated.sequence([
            Animated.spring(scale, { toValue: 1.35, useNativeDriver: true, speed: 50, bounciness: 14 }),
            Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 8 }),
        ]).start();

    const onPress = async () => {
        if (kept) {
            return;
        }
        setKept(true);   // optimistic, so the glyph changes on the same frame as the tap
        pop();
        await MediaManager.keepSong(songId);
    };

    return (
        <Pressable
            onPress={onPress}
            disabled={kept}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={kept ? "Kept" : "Keep song"}
            accessibilityState={{ selected: kept }}
            style={({ pressed }) => [{ opacity: pressed && !kept ? 0.6 : 1 }]}
        >
            <Animated.View style={[{ transform: [{ scale }] }, style]}>
                <Ionicons
                    name={kept ? "bookmark" : "bookmark-outline"}
                    size={size}
                    color={kept ? theme.color.accent : theme.color.textMuted}
                />
            </Animated.View>
        </Pressable>
    );
}
