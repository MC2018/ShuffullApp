import { Button } from "react-native";
import React from "react";
import { MediaManager } from "@/app/services/media-manager";

// TODO: not a proper atom, it's calling MediaManager directly
export default function PlayPauseButton() {
    const handlePlay = async () => {
        await MediaManager.togglePlayback();
    };

    const handleSkip = async () => {
        await MediaManager.skip();
    };
    
    const handlePrevious = async () => {
        await MediaManager.previous();
    };

    return (
        <>
        <Button onPress={handlePlay} title="Play" />
        <Button onPress={handleSkip} title="Skip" />
        <Button onPress={handlePrevious} title="Previous" />
        </>
    );
}
