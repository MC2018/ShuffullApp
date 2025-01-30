import * as MediaManager from "../tools/MediaManager";
import { Button } from "react-native";
import React from "react";

export default function PlayPauseButton() {
    const handlePlay = async () => {

        if (await MediaManager.isPlaying()) {
            await MediaManager.pause();
        } else {
            await MediaManager.play();
        }
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
