import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import TrackPlayer, { Capability, Event, State } from "react-native-track-player";
import { CreateUserSongRequest, RecentlyPlayedSong, Song, UpdateSongLastPlayedRequest } from "../services/db/models";
import * as DbExtensions from "../services/db/dbExtensions";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { generateGuid } from "./utils";
import { RequestType } from "../enums/requestType";

let queue: Song[] = [];
let db: ExpoSQLiteDatabase;
const RECENTLY_PLAYED_MAX_COUNT = 25;

export async function setup(activeDb: ExpoSQLiteDatabase) {
    db = activeDb;
    initTrackPlayer();
}

async function initTrackPlayer() {
    try {
        await TrackPlayer.getActiveTrack(); // error if not set up
    } catch {
        TrackPlayer.registerPlaybackService(() => setupEventListeners);
        await TrackPlayer.setupPlayer(); // TODO: ensure safety for this to be run when app is in foreground
        await TrackPlayer.updateOptions({
            capabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToPrevious,
                Capability.Skip,
                Capability.SkipToNext
            ],
            compactCapabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToPrevious,
                Capability.Skip,
                Capability.SkipToNext
            ],
            notificationCapabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToPrevious,
                Capability.Skip,
                Capability.SkipToNext
            ],
        });
    }
}

async function setupEventListeners() {
    TrackPlayer.addEventListener(Event.RemotePlay, () => play());
    TrackPlayer.addEventListener(Event.RemotePause, () => pause());
    TrackPlayer.addEventListener(Event.RemoteNext, () => skip());
    TrackPlayer.addEventListener(Event.RemotePrevious, () => previous());
}

export async function play() {
    await TrackPlayer.play();
    startNewSong(1);
}

async function startNewSong(songId: number, recentlyPlayedSong?: RecentlyPlayedSong) {
    const localSessionData = await DbExtensions.getActiveLocalSessionData(db);
    const song = await DbExtensions.getSongDetails(db, songId);
    let recentlyPlayedSongFound = false;

    if (!localSessionData) {
        throw Error("No local session data found in startNewSong");
    }

    if (!recentlyPlayedSong) {
        recentlyPlayedSong = await DbExtensions.getCurrentlyPlayingSong(db);

        if (songId != recentlyPlayedSong?.songId) {
            recentlyPlayedSong = undefined;
        }
    }

    await DbExtensions.resetRecentlyPlayedSongTimestamps(db);

    if (recentlyPlayedSong != undefined) {
        if ((await DbExtensions.getRecentlyPlayedSong(db, songId)) != undefined) {
            recentlyPlayedSongFound = true;
        }
    }

    await TrackPlayer.reset();
    await TrackPlayer.add([{
        id: songId,
        url: await generateUrl(song, false),
        title: song.name,
        artist: song.artist?.name ?? "Unknown"
    }]);
    const timeSongStarted = new Date(Date.now());

    if (recentlyPlayedSongFound) {
        await TrackPlayer.seekTo(recentlyPlayedSong?.timestampSeconds ?? 0);
        await DbExtensions.updateRecentlyPlayedSongLastPlayed(db, songId);
    } else {
        await DbExtensions.addRecentlyPlayedSong(db, {
            songId: songId,
            recentlyPlayedSongGuid: generateGuid(),
            timestampSeconds: 0,
            lastPlayed: timeSongStarted
        });
    }

    let userSong = await DbExtensions.getUserSong(db, localSessionData.userId, songId);

    if (userSong == undefined) {
        // TODO: remove CreateUserSongRequest
        const newUserSongRequest: CreateUserSongRequest = {
            userId: localSessionData.userId,
            songId: songId,
            requestGuid: generateGuid(),
            timeRequested: timeSongStarted,
            requestType: RequestType.CreateUserSong
        };
        userSong = {
            userId: newUserSongRequest.userId,
            songId: newUserSongRequest.songId,
            lastPlayed: newUserSongRequest.timeRequested,
            version: newUserSongRequest.timeRequested
        };
        await DbExtensions.addUserSong(db, userSong);
        await DbExtensions.addRequest(db, newUserSongRequest);
    }

    const updateSongLastPlayedRequest: UpdateSongLastPlayedRequest = {
        requestGuid: generateGuid(),
        lastPlayed: timeSongStarted,
        songId: songId,
        timeRequested: timeSongStarted,
        requestType: RequestType.UpdateSongLastPlayed,
        userId: localSessionData.userId
    };
    await DbExtensions.addRequest(db, updateSongLastPlayedRequest);
}

export async function pause() {
    await TrackPlayer.pause();
}

export async function skip() {
    const newSong = queue.shift();

    if (newSong == undefined) {
        
    }
    //await TrackPlayer.reset();
    //startNewSong();
    // remove above and just piggyback off startNewSong
    //await TrackPlayer.
}

export async function previous() {
    await TrackPlayer.skipToPrevious();
}

export async function addToQueue(songId: number) {
    const song = await DbExtensions.getSong(db, songId);

    if (song) {
        queue.push(song);
    }
}

export async function generateUrl(song: Song, offline: boolean) {
    const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

    if (offline) {
        throw Error("Offline play not yet implemented.");
    }

    return `${hostAddress}/music/${song?.directory}`;
}

export async function reset() {
    clearQueue();
}

export async function clearQueue() {
    queue = [];
}

export async function getCurrentPlaylistId() {
    return (await DbExtensions.getActiveLocalSessionData(db))?.currentPlaylistId ?? -1;
}

export async function setCurrentPlaylistId(playlistId: number) {
    await DbExtensions.setActiveLocalSessionPlaylistId(db, playlistId);
}

