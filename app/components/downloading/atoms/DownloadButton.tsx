import { Button } from "react-native";
import React from "react";

export interface DownloadButtonProps {
    onPress: () => void;
}

export default function DownloadButton({ onPress }: DownloadButtonProps) {
    return (
        <Button onPress={onPress} title="Download" />
    );
}
