import React from "react";
import { useProgress } from "react-native-track-player";
import Slider from "@react-native-community/slider";
import { MediaManager } from "../tools";

export default function Skimmer() {
    const { position, duration } = useProgress();

    const handleSlidingComplete = async (value: number) => {
        await MediaManager.seekTo(value);
    };

    return <>
        <Slider 
            style={{width: "100%"}}
            minimumValue={0}
            maximumValue={duration}
            value={position}
            onSlidingComplete={handleSlidingComplete}
            />
    </>;
}
