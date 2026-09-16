import React from "react";
import { Image, ImageSourcePropType, StyleProp, View, ViewStyle } from "react-native";
import { useTheme } from "@/app/theme";

interface Props {
    source?: ImageSourcePropType;
    size: number;
    radius?: number;
    elevated?: boolean;
    style?: StyleProp<ViewStyle>;
}

const fallback = require("@/assets/images/default-album-art.jpg");

// Album art with a placeholder and a subtle static oxblood wash on top (per the Aurora·Oxblood
// "art carries the color" idea). Elevation is applied to an outer wrapper so the shadow isn't
// clipped by the rounded, overflow-hidden image.
export default function AlbumArt({ source, size, radius, elevated, style }: Props) {
    const theme = useTheme();
    const r = radius ?? theme.radius.lg;
    const inner = (
        <View style={{ width: size, height: size, borderRadius: r, backgroundColor: theme.color.surfaceAlt, overflow: "hidden" }}>
            <Image source={source ?? fallback} defaultSource={fallback} style={{ width: "100%", height: "100%" }} />
            <View
                pointerEvents="none"
                style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.color.accentWash }}
            />
        </View>
    );
    if (elevated) {
        return <View style={[theme.shadow.art, { borderRadius: r }, style]}>{inner}</View>;
    }
    return <View style={style}>{inner}</View>;
}
