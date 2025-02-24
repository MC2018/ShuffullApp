import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import TrackPlayer, { Capability, Event, PlaybackState, RemoteSeekEvent, State } from "react-native-track-player";
import { CreateUserSongRequest, RecentlyPlayedSong, Song, UpdateSongLastPlayedRequest } from "../services/db/models";
import * as DbQueries from "../services/db/queries";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { generateGuid, generateRange } from "./utils";
import { RequestType } from "../enums";
import { getPlaybackState } from "react-native-track-player/lib/src/trackPlayer";
import { Downloader } from "./Downloader";
import { create } from "zustand";
import path from "path-browserify";
import { SongFilters } from "../types/SongFilters";

let queue: number[] = [];
let db: ExpoSQLiteDatabase;
let trackPlayerInitialized = false;

interface ActiveSongState {
    songId: number | undefined;
    setSongId: (songId: number) => void;
}

export async function getSongFilters(): Promise<SongFilters> {
    const songFiltersStr = await AsyncStorage.getItem(STORAGE_KEYS.CURRENT_SONG_FILTERS);
    let songFilters = new SongFilters();

    if (songFiltersStr == null || !songFiltersStr.length) {
        await AsyncStorage.setItem(STORAGE_KEYS.CURRENT_SONG_FILTERS, JSON.stringify(songFilters));
    } else {
        // TODO: problem could arise if songfilters is changed
        const parsedFilters: SongFilters = JSON.parse(songFiltersStr);
        Object.setPrototypeOf(parsedFilters, SongFilters.prototype);
        songFilters = parsedFilters;
    }

    return songFilters;
}

export async function setSongFilters(songFilters: SongFilters, clearAndPlay: boolean = false): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEYS.CURRENT_SONG_FILTERS, JSON.stringify(songFilters));

    if (clearAndPlay) {
        await clear();
        await play();
    }
}

export const useActiveSong = create<ActiveSongState>((set) => ({
    songId: undefined,
    setSongId: (id) => set({ songId: id }),
}));

export async function setup(activeDb: ExpoSQLiteDatabase) {
    db = activeDb;
    initTrackPlayer();

    const currentlyPlayingSong = await DbQueries.getCurrentlyPlayingSong(db);

    if (currentlyPlayingSong != undefined) {
        useActiveSong.getState().setSongId(currentlyPlayingSong.songId);
    }
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

    trackPlayerInitialized = true;
}

async function setupEventListeners() {
    TrackPlayer.addEventListener(Event.RemotePlay, async () => await play());
    TrackPlayer.addEventListener(Event.RemotePause, async () => await pause());
    TrackPlayer.addEventListener(Event.RemoteNext, async () => await skip());
    TrackPlayer.addEventListener(Event.RemotePrevious, async () => await previous());
    TrackPlayer.addEventListener(Event.RemoteSeek, async (event: RemoteSeekEvent) => await seekTo(event.position));
    TrackPlayer.addEventListener(Event.PlaybackState, async (state: PlaybackState) => {
        if (state.state != State.Ended) {
            return;
        }

        const songFilters = await getSongFilters();

        if (songFilters.artistIds) {
            return;
        }

        await skip();
    });
}

export async function play() {
    const playbackState = (await getPlaybackState()).state;

    if (playbackState == State.Paused || playbackState == State.Ready) {
        await TrackPlayer.play();
    } else if (playbackState == State.None) {
        const currentlyPlayingSong = await getCurrentlyPlayingSong();

        if (currentlyPlayingSong != null) {
            await startNewSong(currentlyPlayingSong.songId, currentlyPlayingSong);
        } else {
            await skip();
        }
    } else {
        await skip();
    }
}

export async function playSpecificSong(songId: number) {
    await setSongFilters(new SongFilters(), true);
    startNewSong(songId);
}

export async function pause() {
    await TrackPlayer.pause();
}

export async function skip() {
    let recentlyPlayedSong: RecentlyPlayedSong | undefined;
    let songId: number | undefined;

    if (queue.length > 0) {
        const currentSong = await DbQueries.getCurrentlyPlayingSong(db);

        songId = queue.shift()!;

        if (currentSong != undefined) {
            await DbQueries.removeRecentlyPlayedSongsAfter(db, currentSong?.lastPlayed);
        }
    } else {
        recentlyPlayedSong = await DbQueries.checkForNextRecentlyPlayedSong(db);

        if (recentlyPlayedSong != undefined) {
            songId = recentlyPlayedSong.songId;
        } else {
            const songFilters = await getSongFilters();

            if (!songFilters.playlistIds.length) {
                return;
            }

            songId = await getRandomSongId();
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
    const recentlyPlayedSong = await DbQueries.checkForLastRecentlyPlayedSong(db);

    if (recentlyPlayedSong != undefined) {
        const songId = recentlyPlayedSong.songId;
        await startNewSong(songId, recentlyPlayedSong);
    }
}

export async function getPosition() {
    const progress = await TrackPlayer.getProgress();
    return progress.position;
}

export async function addToQueue(songId: number) {
    // Confirms that the song id exists
    const song = await DbQueries.getSong(db, songId);

    if (song) {
        queue.push(songId);
    }
}

export async function generateUrl(song: Song, offline: boolean) {
    const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

    if (offline) {
        throw Error("Offline play not yet implemented.");
    } else if (hostAddress == null) {
        throw Error("Host address not found in AsyncStorage.");
    }

    return path.join(hostAddress, "music", Downloader.generateSongFileName(song));
}

export async function clear() {
    if (!trackPlayerInitialized) {
        return;
    }

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
    await DbQueries.removeAllRecentlyPlayedSongs(db);
    
}

export async function isPlaying() {
    return (await getPlaybackState()).state == State.Playing;
}

export async function getCurrentlyPlayingSong() {
    return await DbQueries.getCurrentlyPlayingSong(db);
}

export async function seekTo(seconds: number) {
    await TrackPlayer.seekTo(seconds);
}

async function startNewSong(songId: number, recentlyPlayedSong?: RecentlyPlayedSong) {
    const localSessionData = await DbQueries.getActiveLocalSessionData(db);
    const songWithArtist = await DbQueries.fetchSongDetails(db, songId);
    const song = songWithArtist.song;
    let recentlyPlayedSongFound = false;
    let songUri: string;

    if (!localSessionData) {
        throw Error("No local session data found in startNewSong");
    }

    if (!recentlyPlayedSong) {
        recentlyPlayedSong = await DbQueries.getCurrentlyPlayingSong(db);

        if (songId != recentlyPlayedSong?.songId) {
            recentlyPlayedSong = undefined;
        }
    }

    await DbQueries.resetRecentlyPlayedSongTimestamps(db);

    if (recentlyPlayedSong != undefined) {
        if ((await DbQueries.getRecentlyPlayedSong(db, recentlyPlayedSong.recentlyPlayedSongGuid)) != undefined) {
            recentlyPlayedSongFound = true;
        }
    }

    if (await Downloader.fileExists(Downloader.generateLocalSongUri(song))) {
        songUri = Downloader.generateLocalSongUri(song);
    } else {
        songUri = await generateUrl(song, false);
    }

    await clearSong();
    await TrackPlayer.add([{
        id: songId,
        url: songUri,
        title: song.name,
        artist: songWithArtist.artists.length > 0 ? songWithArtist.artists.map(x => x.name).join(", ") : "Unknown Artist"
    }]);
    await TrackPlayer.play();

    const timeSongStarted = new Date(Date.now());

    // Update state
    useActiveSong.getState().setSongId(songId);

    if (recentlyPlayedSongFound) {
        const timestampSeconds = recentlyPlayedSong?.timestampSeconds ?? 0;
        await TrackPlayer.seekTo(timestampSeconds);
        await DbQueries.setRecentlyPlayedSongTimestampSeconds(db, recentlyPlayedSong?.recentlyPlayedSongGuid!, timestampSeconds);
    } else {
        await DbQueries.addRecentlyPlayedSong(db, {
            songId: songId,
            recentlyPlayedSongGuid: generateGuid(),
            timestampSeconds: 0,
            lastPlayed: timeSongStarted
        });
    }

    let userSong = await DbQueries.getUserSong(db, localSessionData.userId, songId);

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
        await DbQueries.addUserSong(db, userSong);
        await DbQueries.addRequests(db, [newUserSongRequest]);
    }

    const updateSongLastPlayedRequest: UpdateSongLastPlayedRequest = {
        requestGuid: generateGuid(),
        lastPlayed: timeSongStarted,
        songId: songId,
        timeRequested: timeSongStarted,
        requestType: RequestType.UpdateSongLastPlayed,
        userId: localSessionData.userId
    };
    await DbQueries.updateUserSongLastPlayed(db, localSessionData.userId, songId, timeSongStarted);
    await DbQueries.addRequests(db, [updateSongLastPlayedRequest]);
}

// TODO: support multiple playlists, and all filters in general
async function getRandomSongId(): Promise<number | undefined> {
    const songFilters = await getSongFilters();
    let songId: number | undefined;

    if (songFilters.playlistIds.length) {
        songId = await DbQueries.getRandomSongIdByPlaylist(db, songFilters.playlistIds[0]);
        
        if (songId == undefined) {
            throw Error("Attempted to get a playlist song, but no songs exist.");
        }
    } else {
        // Use case: when you select a specific song to play, the next song to play will be nothing
        return undefined;
    }

    return songId;
}
