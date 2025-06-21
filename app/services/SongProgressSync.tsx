import { useEffect, useState } from "react";
import { useDb } from "./db/DbProvider";
import DbQueries from "./db/queries";
import React from "react";
import BackgroundService from 'react-native-background-actions';
import { sleep, generateId } from "../tools";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
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

        const veryIntensiveTask = async (taskDataArguments: { id: string } | undefined) => {
            const { id } = taskDataArguments!;
            
            await new Promise(async (resolve) => {
                for (let i = 0; await AsyncStorage.getItem(STORAGE_KEYS.FOREGROUND_TIMER_ID) == id; i++) {
                    await sleep(1000);
                }
            });
        };

        const options = {
            taskName: "SongProgress",
            taskTitle: "SongProgress",
            taskDesc: "Updating song progress in the background",
            taskIcon: {
                name: "ic_launcher",
                type: "mipmap",
            },
            parameters: {
                id: generateId()
            },
        };
        
        (async () => {
            await AsyncStorage.setItem(STORAGE_KEYS.FOREGROUND_TIMER_ID, options.parameters.id);
            await BackgroundService.start(veryIntensiveTask, options);
        })();

        return () => clearInterval(interval);
    }, []);

    return <></>;
}
