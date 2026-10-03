import { useEffect } from "react";
import { useDb } from "./db/DbProvider";
import DbQueries from "./db/queries";
import React from "react";
import { MediaManager } from "./media-manager";

export default function SongProgressSync() {
    const db = useDb();

    useEffect(() => {
        const interval = setInterval(async () => {
            const isPlaying = await MediaManager.isPlaying();

            if (!isPlaying) {
                return;
            }

            const newPosition = await MediaManager.getPosition();
            const currentlyPlayingSong = await DbQueries.getCurrentlyPlayingSong(db);

            if (currentlyPlayingSong != undefined && newPosition != currentlyPlayingSong.timestampSeconds) {
                await DbQueries.setRecentlyPlayedSongTimestampSeconds(db, currentlyPlayingSong.recentlyPlayedSongId, newPosition);
            }
        }, 1000);

        // This used to start a permanent react-native-background-actions foreground service so the interval
        // above would keep firing after Home. Verified redundant on 2026-09-18: react-native-track-player's
        // MusicService is itself a headless JS task, and RN keeps timers running while any headless task is
        // active — with no service of ours at all, the persisted position advanced 38.7 s → 69.2 s over 30 s
        // of backgrounded playback. The service also cost a permanent notification (invisible until the app
        // gained POST_NOTIFICATIONS), a 6 h/24 h dataSync budget, and died anyway when the app was swiped
        // away. Downloads now hold the service only while they have work (background/foregroundService.ts).
        //
        // Known trade-off: the outbox's 10 s tick no longer runs while the app is backgrounded AND idle
        // (not playing, not downloading); queued requests go out on the next foreground/play instead.

        return () => clearInterval(interval);
    }, []);

    return <></>;
}
