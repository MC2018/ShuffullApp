import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import TrackPlayer, { Capability, Event, State, usePlaybackState } from "react-native-track-player";
import { CreateUserSongRequest, RecentlyPlayedSong, Song, UpdateSongLastPlayedRequest } from "../services/db/models";
import * as DbExtensions from "../services/db/dbExtensions";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { generateGuid } from "./utils";
import { RequestType } from "../enums";
import { getPlaybackState } from "react-native-track-player/lib/src/trackPlayer";

let queue: number[] = [];
let queueIndex: number | undefined = undefined;
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
    const playbackState = (await getPlaybackState()).state;

    if (playbackState == State.Paused) {
        await TrackPlayer.play();
    } else {
        let songId = await getNextSongId();
        await startNewSong(songId);
    }
}

export async function pause() {
    await TrackPlayer.pause();
}

export async function skip() {
    const songId = await getNextSongId();

    // TODO: implement feature to track when a song is skipped early

    await startNewSong(songId);
}

export async function previous() {
    const songId = await getNextSongId(true);
    await startNewSong(songId);
}

export async function addToQueue(songId: number) {
    // Confirms that the song id exists
    const song = await DbExtensions.getSong(db, songId);

    if (song) {
        queue.push(songId);
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
    clearSong();
}

export async function clearSong() {
    await TrackPlayer.reset();
}

export async function clearQueue() {
    queue = [];
}

export async function getCurrentPlaylistId() {
    return (await DbExtensions.getActiveLocalSessionData(db))?.currentPlaylistId ?? undefined;
}

export async function setCurrentPlaylistId(playlistId: number) {
    await DbExtensions.setActiveLocalSessionPlaylistId(db, playlistId);
}

export async function isPlaying() {
    return (await getPlaybackState()).state == State.Playing;
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
    await TrackPlayer.play();
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

async function getNextSongId(previous: boolean = false): Promise<number> {
    let songId: number;
    
    if (queueIndex == undefined && queue.length > 0) {
        queueIndex = 0;
        songId = queue[queueIndex];
    } else if (previous && queueIndex != undefined) {
        if (queueIndex - 1 >= 0) {
            songId = queue[--queueIndex];
        } else if (queue.length > 0) {
            songId = queue[0];
        } else {
            throw Error("Queue has no songs, the previous song cannot be reached.");
        }
    } else if (!previous && queueIndex != undefined && queueIndex + 1 < queue.length) {
        songId = queue[++queueIndex];
    } else {
        const localSessionData = await DbExtensions.getActiveLocalSessionData(db);
        let potentialSongId: number | undefined;

        if (localSessionData?.currentPlaylistId != undefined && localSessionData?.currentPlaylistId != -1) {
            potentialSongId = await DbExtensions.getRandomSongIdByPlaylist(db, localSessionData?.currentPlaylistId);
        } else {
            potentialSongId = await DbExtensions.getRandomSongId(db);
        }
            
        if (potentialSongId == undefined) {
            throw Error("Attempted to get a song, but no songs exist.");
        }
    
        songId = potentialSongId;
        queue.push(songId);
        queueIndex = queue.length - 1;
    }

    console.log("Queue: " + queue);
    console.log("Queue Index: " + queueIndex);

    return songId;
}
