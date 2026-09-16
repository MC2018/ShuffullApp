import { useEffect, useState } from "react";
import { Platform } from "react-native";
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
            foregroundServiceType: ['dataSync'] as ('dataSync')[],
        };
        
        (async () => {
            await AsyncStorage.setItem(STORAGE_KEYS.FOREGROUND_TIMER_ID, options.parameters.id);

            // react-native-background-actions keeps an Android FOREGROUND SERVICE alive so the interval above
            // keeps running while the app is backgrounded. It is native-only and ships no web implementation:
            // the JS wrapper's start() exists but immediately dereferences a native module that isn't there,
            // throwing "Cannot read properties of undefined (reading 'start')" as an unhandled rejection on
            // every desktop launch. (Guarding on `BackgroundService.start` is NOT enough — the method is
            // present; it's what it reaches for that's missing.)
            //
            // Nothing is lost by skipping it here: an open desktop window is already foreground, and the
            // interval above runs regardless. The try/catch covers any other platform lacking the module.
            if (Platform.OS === "web") {
                return;
            }

            try {
                await BackgroundService.start(veryIntensiveTask, options);
            } catch (e) {
                console.warn("Background progress service unavailable; progress still syncs while open.", e);
            }
        })();

        return () => clearInterval(interval);
    }, []);

    return <></>;
}
