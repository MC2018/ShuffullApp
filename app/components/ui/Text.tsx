import React from "react";
import { Text as RNText, TextProps, StyleProp, TextStyle } from "react-native";
import { useTheme, TypographyVariant, ColorToken } from "@/app/theme";

interface Props extends TextProps {
    variant?: TypographyVariant;
    color?: ColorToken;
    children?: React.ReactNode;
}

// Themed text. Picks a size/weight/line-height from the type scale and a color from the palette.
export default function Text({ variant = "body", color = "textPrimary", style, children, ...rest }: Props) {
    const theme = useTheme();
    const variantStyle = theme.typography[variant] as TextStyle;
    const composed: StyleProp<TextStyle> = [
        variantStyle,
        { color: theme.color[color] },
        theme.font.family ? { fontFamily: theme.font.family } : null,
        style,
    ];
    return (
        <RNText style={composed} {...rest}>
            {children}
        </RNText>
    );
}
