import React from "react";
import { Pressable, View, StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/app/theme";
import Text from "./Text";

interface Props {
    title: string;
    subtitle?: string;
    left?: React.ReactNode; // art / swatch
    right?: React.ReactNode; // trailing slot (count, chevron, action)
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
}

export default function ListRow({ title, subtitle, left, right, onPress, style }: Props) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [
                { flexDirection: "row", alignItems: "center", gap: theme.space.md, paddingVertical: theme.space.md, opacity: pressed ? 0.7 : 1 },
                style,
            ]}
        >
            {left}
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyStrong" numberOfLines={1}>
                    {title}
                </Text>
                {subtitle ? (
                    <Text variant="caption" color="textFaint" numberOfLines={1} style={{ marginTop: 2 }}>
                        {subtitle}
                    </Text>
                ) : null}
            </View>
            {right}
        </Pressable>
    );
}
