import React from "react";
import { View, ViewProps, StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/app/theme";

interface Props extends ViewProps {
    padded?: boolean; // apply the standard horizontal screen padding
    children?: React.ReactNode;
}

// Themed screen container (the dark canvas + optional horizontal padding).
//
// NOTE: top safe-area is currently handled by the root layout's paddingTop offset; once that hack
// is removed (Phase 2) this should adopt SafeAreaView from react-native-safe-area-context.
export default function Screen({ padded = true, style, children, ...rest }: Props) {
    const theme = useTheme();
    const base: StyleProp<ViewStyle> = [
        { flex: 1, backgroundColor: theme.color.bg },
        padded ? { paddingHorizontal: theme.space.lg } : null,
        style,
    ];
    return (
        <View style={base} {...rest}>
            {children}
        </View>
    );
}
