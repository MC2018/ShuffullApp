import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import TrackPlayer, { Capability, Event, PlaybackState, RemoteSeekEvent, State } from "react-native-track-player";
import { CreateUserSongRequest, RecentlyPlayedSong, Song, UpdateSongLastPlayedRequest } from "../services/db/models";
import * as DbExtensions from "../services/db/dbExtensions";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { generateGuid, generateRange } from "./utils";
import { RequestType } from "../enums";
import { getPlaybackState } from "react-native-track-player/lib/src/trackPlayer";
import { generateLocalSongUri, songFileExists } from "./DownloadManager";

let queue: number[] = [];
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
                Capability.SkipToNext,
                Capability.SeekTo
            ],
            compactCapabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToPrevious,
                Capability.Skip,
                Capability.SkipToNext,
                Capability.SeekTo
            ],
            notificationCapabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToPrevious,
                Capability.Skip,
                Capability.SkipToNext,
                Capability.SeekTo
            ],
        });
    }
}

async function setupEventListeners() {
    TrackPlayer.addEventListener(Event.RemotePlay, async () => await play());
    TrackPlayer.addEventListener(Event.RemotePause, async () => await pause());
    TrackPlayer.addEventListener(Event.RemoteNext, async () => await skip());
    TrackPlayer.addEventListener(Event.RemotePrevious, async () => await previous());
    TrackPlayer.addEventListener(Event.PlaybackState, async (state: PlaybackState) => {
        if (state.state != State.Ended) {
            return;
        }

        const playlistId = await getCurrentPlaylistId();

        if (playlistId == -1 || playlistId == undefined) {
            return;
        }

        await skip();
    });
    TrackPlayer.addEventListener(Event.RemoteSeek, async (event: RemoteSeekEvent) => {
        await seekTo(event.position);
    });
}

export async function play() {
    const playbackState = (await getPlaybackState()).state;

    if (playbackState == State.Paused) {
        await TrackPlayer.play();
    } else {
        await skip();
    }
}

export async function playSpecificSong(songId: number) {
    await setPlaylist(-1);
    startNewSong(songId);
}

export async function pause() {
    await TrackPlayer.pause();
}

export async function skip() {
    let recentlyPlayedSong: RecentlyPlayedSong | undefined;
    let songId: number | undefined;

    if (queue.length > 0) {
        const currentSong = await DbExtensions.getCurrentlyPlayingSong(db);

        songId = queue.shift()!;

        if (currentSong != undefined) {
            await DbExtensions.removeRecentlyPlayedSongsAfter(db, currentSong?.lastPlayed);
        }
    } else {
        recentlyPlayedSong = await DbExtensions.checkForNextRecentlyPlayedSong(db);

        if (recentlyPlayedSong != undefined) {
            songId = recentlyPlayedSong.songId;
        } else {
            const localSessionData = await DbExtensions.getActiveLocalSessionData(db);

            if (localSessionData != undefined &&
                (localSessionData.currentPlaylistId == undefined || localSessionData.currentPlaylistId == -1)) {
                return;
            }

            songId = await getNextSongId();
        }
    }

    // No song should play next
    if (songId == undefined) {
        return;
    }

    if (recentlyPlayedSong != undefined) {
        await startNewSong(songId, recentlyPlayedSong);
    } else {
        await startNewSong(songId);
    }

    // TODO: implement feature to track when a song is skipped early
}

export async function previous() {
    const recentlyPlayedSong = await DbExtensions.checkForLastRecentlyPlayedSong(db);

    if (recentlyPlayedSong != undefined) {
        const songId = recentlyPlayedSong.songId;
        await startNewSong(songId, recentlyPlayedSong);
    }
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
    await clearSong();
    await clearRecentlyPlayed();
}

export async function clearSong() {
    // Running TrackPlayer.reset() causes a 300ms delay,
    // Removing the songs individually is more ideal
    const trackPlayerQueue = await TrackPlayer.getQueue();
    TrackPlayer.remove(generateRange(trackPlayerQueue.length));
}

export function clearQueue() {
    queue = [];
}

export async function clearRecentlyPlayed() {
    await DbExtensions.removeAllRecentlyPlayedSongs(db);
}

export async function getCurrentPlaylistId() {
    return (await DbExtensions.getActiveLocalSessionData(db))?.currentPlaylistId ?? undefined;
}

export async function isPlaying() {
    return (await getPlaybackState()).state == State.Playing;
}

export async function setPlaylist(playlistId: number) {
    await DbExtensions.setActiveLocalSessionPlaylistId(db, playlistId);
    await reset();
}

export async function getCurrentlyPlayingSong() {
    return await DbExtensions.getCurrentlyPlayingSong(db);
}

export async function seekTo(seconds: number) {
    await TrackPlayer.seekTo(seconds);
}

async function startNewSong(songId: number, recentlyPlayedSong?: RecentlyPlayedSong) {
    const localSessionData = await DbExtensions.getActiveLocalSessionData(db);
    const song = await DbExtensions.getSongDetails(db, songId);
    let recentlyPlayedSongFound = false;
    let songUri: string;

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
        if ((await DbExtensions.getRecentlyPlayedSong(db, recentlyPlayedSong.recentlyPlayedSongGuid)) != undefined) {
            recentlyPlayedSongFound = true;
        }
    }

    if (await songFileExists(song.directory)) {
        songUri = generateLocalSongUri(song.directory);
    } else {
        songUri = await generateUrl(song, false);
    }

    await clearSong();
    await TrackPlayer.add([{
        id: songId,
        url: songUri,
        title: song.name,
        artist: song.artist?.name ?? "Unknown"
    }]);
    await TrackPlayer.play();

    const timeSongStarted = new Date(Date.now());

    if (recentlyPlayedSongFound) {
        await TrackPlayer.seekTo(recentlyPlayedSong?.timestampSeconds ?? 0);
        await DbExtensions.updateRecentlyPlayedSongTimestamp(db, recentlyPlayedSong?.recentlyPlayedSongGuid!);
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
    await DbExtensions.updateUserSongLastPlayed(db, localSessionData.userId, songId, timeSongStarted);
    await DbExtensions.addRequest(db, updateSongLastPlayedRequest);
}

async function getNextSongId(): Promise<number | undefined> {
    const currentPlaylistId = await getCurrentPlaylistId();
    let songId: number | undefined;

    if (currentPlaylistId != undefined && currentPlaylistId != -1) {
        songId = await DbExtensions.getRandomSongIdByPlaylist(db, currentPlaylistId);
        
        if (songId == undefined) {
            throw Error("Attempted to get a playlist song, but no songs exist.");
        }
    } else {
        // Use case: when you select a specific song to play, the next song to play will be nothing
        return undefined;
    }

    return songId;
}
