import React from "react";
import { Pressable, StyleProp, ViewStyle } from "react-native";
import { useTheme, ColorToken } from "@/app/theme";
import Text from "./Text";

type ChipState = "idle" | "selected" | "excluded";

interface Props {
    label: string;
    state?: ChipState;
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
}

// Pill used for moods, tags, and include/exclude filters.
export default function Chip({ label, state = "idle", onPress, style }: Props) {
    const theme = useTheme();
    const bg =
        state === "selected" ? theme.color.accent : state === "excluded" ? theme.color.neutralFill : theme.color.surface;
    const fg: ColorToken = state === "selected" ? "onAccent" : state === "excluded" ? "textFaint" : "textMuted";
    const border = state === "idle" ? theme.color.line : "transparent";
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [
                {
                    paddingVertical: theme.space.sm,
                    paddingHorizontal: theme.space.md,
                    borderRadius: theme.radius.pill,
                    backgroundColor: bg,
                    borderWidth: 1,
                    borderColor: border,
                    opacity: pressed ? 0.85 : 1,
                },
                style,
            ]}
        >
            <Text variant="label" color={fg}>
                {label}
            </Text>
        </Pressable>
    );
}
