import TrackPlayer, {Capability, Event} from "react-native-track-player";
import { Track } from "react-native-track-player";

export async function init() {
    let isSetup = false;

    try {
        await TrackPlayer.getActiveTrackIndex();
        isSetup = true;
    } catch (error) {
        await TrackPlayer.setupPlayer(); // TODO: ensure safety for this to be run when app is in foreground
        await TrackPlayer.updateOptions({
            capabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToNext,
                //Capability.SkipToPrevious,
                Capability.Stop,
            ],
            compactCapabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToNext,
                //Capability.SkipToPrevious,
            ],
            notificationCapabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToNext,
                Capability.SkipToPrevious,
                //Capability.SeekTo,
            ],
        });
        TrackPlayer.registerPlaybackService(() => playbackService);
        isSetup = true;
    } finally {
        return isSetup;
    }
}

export async function addToQueue(tracks: Track[]) {
    await TrackPlayer.add(tracks);
}

async function playbackService() {
    TrackPlayer.addEventListener(Event.RemotePause, () => {
        TrackPlayer.pause();
    });
    TrackPlayer.addEventListener(Event.RemotePlay, () => {
        TrackPlayer.play();
    });
}