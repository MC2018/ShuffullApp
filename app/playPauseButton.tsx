import TrackPlayer, { State, usePlaybackState } from "react-native-track-player";
import * as MediaManager from "./tools/mediaManager";
import { Button } from "react-native";
import * as DbExtensions from "./services/db/dbExtensions";
import { useDb } from "./services/db/dbProvider";
import { useApi } from "./services/api/apiProvider";

export default function PlayPauseButton() {
    const db = useDb();
    const api = useApi();
    const playbackState = usePlaybackState().state;

    const handlePlay = async () => {
        const currentTrack = await TrackPlayer.getActiveTrack();
        
        if (!currentTrack) {
            const song = await DbExtensions.getRandomSong(db);

            if (!song) {
                console.log("No songs are found.");
                return;
            }
            console.log(song);
            MediaManager.addToQueue([
                {
                    id: 1,
                    url: `${api.getBaseURL()}/music/${song?.directory}`,
                    title: song.name,
                    artist: song.artist?.name ?? "Unknown"
                }
            ]);
        }

        if (playbackState === undefined) {
            return;
        }

        console.log(playbackState);

        if (playbackState === State.Paused || playbackState === State.Ready || playbackState === State.None) {
            await TrackPlayer.play();
        } else {
            await TrackPlayer.pause();
        }
    };

    return (
        <>
        <Button onPress={handlePlay} title="Play" />
        </>
    );
}
