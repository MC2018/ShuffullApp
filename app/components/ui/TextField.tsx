import React from "react";
import { TextInput, TextInputProps } from "react-native";
import { useTheme } from "@/app/theme";

// Themed single-line text input.
export default function TextField({ style, ...rest }: TextInputProps) {
    const theme = useTheme();
    return (
        <TextInput
            placeholderTextColor={theme.color.textFaint}
            style={[
                {
                    backgroundColor: theme.color.surface,
                    borderWidth: 1,
                    borderColor: theme.color.line,
                    borderRadius: theme.radius.md,
                    paddingVertical: theme.space.md,
                    paddingHorizontal: theme.space.lg,
                    color: theme.color.textPrimary,
                    fontSize: 14,
                },
                style,
            ]}
            {...rest}
        />
    );
}
