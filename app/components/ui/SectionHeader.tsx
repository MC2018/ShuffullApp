import React from "react";
import { View, Pressable, StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/app/theme";
import Text from "./Text";

interface Props {
    title: string;
    actionLabel?: string;
    onAction?: () => void;
    style?: StyleProp<ViewStyle>;
}

export default function SectionHeader({ title, actionLabel, onAction, style }: Props) {
    const theme = useTheme();
    return (
        <View
            style={[
                { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: theme.space.xl, marginBottom: theme.space.md },
                style,
            ]}
        >
            <Text variant="section">{title}</Text>
            {actionLabel ? (
                <Pressable onPress={onAction}>
                    <Text variant="label" color="textMuted">
                        {actionLabel}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}
