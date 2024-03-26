import TrackPlayer, {Event} from "react-native-track-player";
import {playlistData} from "./constants";

export async function setupPlayer() {
    let isSetup = false;

    try {
        await TrackPlayer.getActiveTrackIndex();
        isSetup = true;
    } catch (error) {
        await TrackPlayer.setupPlayer();
        isSetup = true;
    } finally {
        return isSetup;
    }
}

export async function addTrack() {
    await TrackPlayer.add(playlistData);
}

export async function playbackService() {
    TrackPlayer.addEventListener(Event.RemotePause, () => {
        TrackPlayer.pause();
    });
    TrackPlayer.addEventListener(Event.RemotePlay, () => {
        TrackPlayer.play();
    });
}