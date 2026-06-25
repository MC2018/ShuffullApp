import React from "react";
import { View, StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/app/theme";

interface Props {
    children?: React.ReactNode;
    tint?: boolean; // accentWash background instead of the default surface
    bordered?: boolean;
    style?: StyleProp<ViewStyle>;
}

export default function Card({ children, tint, bordered = true, style }: Props) {
    const theme = useTheme();
    return (
        <View
            style={[
                {
                    backgroundColor: tint ? theme.color.accentWash : theme.color.surface,
                    borderRadius: theme.radius.lg,
                    padding: theme.space.lg,
                },
                bordered ? { borderWidth: 1, borderColor: theme.color.line } : null,
                style,
            ]}
        >
            {children}
        </View>
    );
}
