import React from "react";
import { Pressable, StyleProp, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, ColorToken } from "@/app/theme";
import Text from "./Text";

type Variant = "primary" | "ghost" | "danger";

interface Props {
    label: string;
    onPress?: () => void;
    variant?: Variant;
    icon?: keyof typeof Ionicons.glyphMap;
    disabled?: boolean;
    full?: boolean;
    style?: StyleProp<ViewStyle>;
}

export default function Button({ label, onPress, variant = "primary", icon, disabled, full, style }: Props) {
    const theme = useTheme();
    const bg =
        variant === "primary" ? theme.color.accent : variant === "ghost" ? theme.color.surface : theme.color.neutralFill;
    const fg: ColorToken = variant === "primary" ? "onAccent" : variant === "ghost" ? "textPrimary" : "textMuted";
    const border = variant === "ghost" ? theme.color.line : "transparent";
    const iconColor = variant === "primary" ? theme.color.onAccent : theme.color.textPrimary;

    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            style={({ pressed }) => [
                {
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: theme.space.sm,
                    backgroundColor: bg,
                    borderWidth: 1,
                    borderColor: border,
                    paddingVertical: theme.space.md,
                    paddingHorizontal: theme.space.lg,
                    borderRadius: theme.radius.md,
                    opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
                },
                full ? { alignSelf: "stretch" } : null,
                style,
            ]}
        >
            {icon ? <Ionicons name={icon} size={16} color={iconColor} /> : null}
            <Text variant="label" color={fg}>
                {label}
            </Text>
        </Pressable>
    );
}
