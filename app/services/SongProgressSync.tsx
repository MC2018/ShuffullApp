import { useEffect, useState } from "react";
import { useDb } from "./db/DbProvider";
import * as DbQueries from "./db/queries";
import React from "react";
import BackgroundService from 'react-native-background-actions';
import { generateGuid, sleep, MediaManager } from "../tools";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";

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
                await DbQueries.setRecentlyPlayedSongTimestampSeconds(db, currentlyPlayingSong.recentlyPlayedSongGuid, newPosition);
            }
        }, 1000);

        const veryIntensiveTask = async (taskDataArguments: { guid: string } | undefined) => {
            const { guid } = taskDataArguments!;
            
            await new Promise(async (resolve) => {
                for (let i = 0; await AsyncStorage.getItem(STORAGE_KEYS.FOREGROUND_TIMER_GUID) == guid; i++) {
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
                guid: generateGuid()
            },
        };
        
        (async () => {
            await AsyncStorage.setItem(STORAGE_KEYS.FOREGROUND_TIMER_GUID, options.parameters.guid);
            await BackgroundService.start(veryIntensiveTask, options);
        })();

        return () => clearInterval(interval);
    }, []);

    return <></>;
}
