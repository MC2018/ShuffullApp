import React from "react";
import { View, StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/app/theme";

export default function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
    const theme = useTheme();
    return <View style={[{ height: 1, backgroundColor: theme.color.line }, style]} />;
}
