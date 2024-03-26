import React from 'react';
import TrackPlayer, { State, usePlaybackState } from 'react-native-track-player';
//import Icon from 'react-native-vector-icons/MaterialIcons';
import { playbackService } from '../musicPlayerServices';
import { Pressable } from 'react-native-windows';
import { Text, View } from 'react-native';

const ControlCenter = () => {
    const rawPlaybackState = usePlaybackState();
    const playbackState: State = rawPlaybackState.state === undefined ? State.Paused : rawPlaybackState.state;
    const togglePlayback = async (playback: State) => {
        const currentTrack = await TrackPlayer.getActiveTrack();

        console.log("OI!!");
        if (currentTrack !== undefined) {
            console.log("OI!!");
            if (playback === State.Paused || playback === State.Ready) {
                await TrackPlayer.play();
            } else {
                await TrackPlayer.pause();
            }
        }
    };

    return (
        <View>
            <Pressable onPress={() => togglePlayback(playbackState)}><Text>PRESSABLE PLAY/PAUSE</Text></Pressable>
        </View>
    );
}

export default ControlCenter;