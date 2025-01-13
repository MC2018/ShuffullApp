import TrackPlayer, { State, usePlaybackState } from "react-native-track-player";
import * as MediaManager from "../tools/MediaManager";
import { Button } from "react-native";
import * as DbExtensions from "../services/db/dbExtensions";
import { useDb } from "../services/db/dbProvider";
import { useApi } from "../services/api/apiProvider";
import React from "react";

export default function PlayPauseButton() {
    const db = useDb();
    const api = useApi();
    const playbackState = usePlaybackState().state;

    const handlePlay = async () => {
        const currentTrack = await TrackPlayer.getActiveTrack();
        
        if (!currentTrack) {
            const songId = await DbExtensions.getRandomSongId(db);

            if (!songId) {
                console.log("No songs are found.");
                return;
            }
        }

        if (playbackState === undefined) {
            return;
        }

        console.log(playbackState);

        if (playbackState === State.Paused || playbackState === State.Ready || playbackState === State.None) {
            await MediaManager.play();
        } else {
            await MediaManager.pause();
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
