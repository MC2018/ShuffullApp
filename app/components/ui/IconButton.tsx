import React from "react";
import { Pressable, StyleProp, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/app/theme";

interface Props {
    name: keyof typeof Ionicons.glyphMap;
    onPress?: () => void;
    size?: number; // icon glyph size
    color?: string; // icon color; defaults to textPrimary, or onAccent when filled
    filled?: boolean; // circular accent background (e.g. the play button)
    round?: number; // diameter when filled
    hitSlop?: number;
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
}

export default function IconButton({
    name,
    onPress,
    size = 22,
    color,
    filled,
    round = 56,
    hitSlop = 8,
    style,
    accessibilityLabel,
}: Props) {
    const theme = useTheme();
    const iconColor = color ?? (filled ? theme.color.onAccent : theme.color.textPrimary);
    return (
        <Pressable
            onPress={onPress}
            hitSlop={hitSlop}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            style={({ pressed }) => [
                filled
                    ? {
                          width: round,
                          height: round,
                          borderRadius: theme.radius.pill,
                          backgroundColor: theme.color.accent,
                          alignItems: "center",
                          justifyContent: "center",
                      }
                    : null,
                { opacity: pressed ? 0.7 : 1 },
                style,
            ]}
        >
            <Ionicons name={name} size={size} color={iconColor} />
        </Pressable>
    );
}
