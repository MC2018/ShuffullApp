import { GenericDb } from "../db/GenericDb";
import TrackPlayer, { Capability, Event, PlaybackState, RemoteSeekEvent, State } from "react-native-track-player";
import { CreateUserSongRequest, RecentlyPlayedSong, Request, Song, UpdateSongLastPlayedRequest } from "../db/models";
import DbQueries from "../db/queries";
import { shouldPromoteOnLike } from "../../tools/promotion";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { generateRange, generateId } from "../../tools/utils";
import { RequestType, LikeStatus } from "../../enums";
import { getPlaybackState } from "react-native-track-player/lib/src/trackPlayer";
import { Downloader } from "../downloader/Downloader";
import { create } from "zustand";
import path from "path-browserify";
import { SongFilters } from "../../types/SongFilters";

let queue: string[] = [];
let db: GenericDb;
let trackPlayerInitialized = false;

interface ActiveSongState {
    songId: string | undefined;
    setSongId: (songId: string) => void;
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

interface LikeStatusState {
    // Reactive mirror of per-song like state so the in-app rating UI updates no matter where a change
    // originates — the in-app control or the notification's 👍/👎 buttons. applyLikeStatus is the only writer.
    statuses: Record<string, LikeStatus>;
    setLikeStatus: (songId: string, status: LikeStatus) => void;
}

export const useLikeStatus = create<LikeStatusState>((set) => ({
    statuses: {},
    setLikeStatus: (songId, status) => set((s) => ({ statuses: { ...s.statuses, [songId]: status } })),
}));

export async function setup(activeDb: GenericDb) {
    db = activeDb;
    initTrackPlayer();

    const currentlyPlayingSong = await DbQueries.getCurrentlyPlayingSong(db);

    if (currentlyPlayingSong != undefined) {
        useActiveSong.getState().setSongId(currentlyPlayingSong.songId);
    }
}

// Notification 👍/👎 button icon indices. The withNotificationActionIcons config plugin overrides the fork's
// built-in icon slots with thumb variants: 0 = thumb-up outline, 1 = thumb-up solid, 2 = thumb-down outline,
// 3 = thumb-down solid — so each button shows solid when its state is active and outline otherwise.
function buildPlayerOptions(likeStatus: LikeStatus) {
    const disliked = likeStatus === LikeStatus.Dislike;
    // Like button mirrors the in-app cycle: neutral = outline thumb (0), Like = solid thumb (1), Love = heart (4).
    const likeIcon = likeStatus === LikeStatus.Love ? 4 : likeStatus === LikeStatus.Like ? 1 : 0;
    const transport = [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToPrevious,
        Capability.Skip,
        Capability.SkipToNext,
        Capability.SeekTo,
    ];
    return {
        capabilities: transport,
        compactCapabilities: transport,
        notificationCapabilities: transport,
        // Media3 custom notification buttons (lovegaoshi RNTP fork): always-visible 👍/👎. The like button
        // cycles neutral → Like → Love (icons 0 → 1 → 4) and 👎 toggles dislike (2 ↔ 3), via the
        // RemoteCustomAction handler. (The fork's { uri } icon path doesn't resolve reliably on our stack.)
        customActions: {
            customActionsList: ["like", "dislike"],
            like: likeIcon,
            dislike: disliked ? 3 : 2,
        },
    };
}

// Reflect a song's like state on the notification's 👍/👎 buttons. Safe to call repeatedly; updateOptions
// re-applies the custom layout. Meaningful only for the active track.
async function refreshNotificationButtons(likeStatus: LikeStatus) {
    try {
        await TrackPlayer.updateOptions(buildPlayerOptions(likeStatus));
    } catch {
        // Non-critical: the notification buttons are best-effort.
    }
}

async function initTrackPlayer() {
    try {
        await TrackPlayer.getActiveTrack(); // error if not set up
    } catch {
        TrackPlayer.registerPlaybackService(() => setupEventListeners);
        await TrackPlayer.setupPlayer(); // TODO: ensure safety for this to be run when app is in foreground
        // Start with both buttons in the neutral (outline) state; refreshed once a song becomes active.
        await TrackPlayer.updateOptions(buildPlayerOptions(LikeStatus.Neutral));
    }

    trackPlayerInitialized = true;
}

async function setupEventListeners() {
    TrackPlayer.addEventListener(Event.RemotePlay, async () => await play());
    TrackPlayer.addEventListener(Event.RemotePause, async () => await pause());
    TrackPlayer.addEventListener(Event.RemoteNext, async () => await skip());
    TrackPlayer.addEventListener(Event.RemotePrevious, async () => await previous());
    TrackPlayer.addEventListener(Event.RemoteSeek, async (event: RemoteSeekEvent) => await seekTo(event.position));
    // Notification 👍/👎 custom buttons for the active song (Android). 👍 cycles Neutral → Like → Love →
    // Neutral (mirroring the in-app RatingControl); 👎 toggles Dislike ↔ Neutral.
    TrackPlayer.addEventListener(Event.RemoteCustomAction, async (event) => {
        const activeSongId = useActiveSong.getState().songId;
        if (activeSongId == undefined) {
            return;
        }
        const sessionData = await DbQueries.getActiveLocalSessionData(db);
        if (!sessionData) {
            return;
        }
        const current = ((await DbQueries.getUserSong(db, sessionData.userId, activeSongId))?.likeStatus as LikeStatus) ?? LikeStatus.Neutral;
        if (event.customAction === "like") {
            const next =
                current === LikeStatus.Like ? LikeStatus.Love : current === LikeStatus.Love ? LikeStatus.Neutral : LikeStatus.Like;
            await applyLikeStatus(activeSongId, next);
        } else if (event.customAction === "dislike") {
            await applyLikeStatus(activeSongId, current === LikeStatus.Dislike ? LikeStatus.Neutral : LikeStatus.Dislike);
        }
    });
    TrackPlayer.addEventListener(Event.PlaybackState, async (state: PlaybackState) => {
        if (state.state != State.Ended) {
            return;
        }

        await skip();
    });
}

export async function play() {
    const playbackState = (await getPlaybackState()).state;

    // "Resume" only means something if a track is actually LOADED. Without this check the branch below depends
    // on the player distinguishing None from Ready exactly right, and a Ready-but-empty player swallowed the
    // call: TrackPlayer.play() on an empty queue does nothing, which is how the playlist Play button came to
    // silently do nothing on desktop. getActiveTrack throws on an uninitialised player, so treat that as
    // "nothing loaded" rather than letting it escape.
    let hasTrack = false;
    try {
        hasTrack = (await TrackPlayer.getActiveTrack()) != undefined;
    } catch {
        hasTrack = false;
    }

    if (hasTrack && (playbackState == State.Paused || playbackState == State.Ready)) {
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

/**
 * Plays a song the user picked out of a list, and sets the SCOPE that playback continues in once it ends.
 *
 * `scope` is the context the song was picked from — a playlist, an artist, the downloads list. Passing it is
 * what keeps the music going: when a song finishes, `skip()` finds the next one through the current filters,
 * so a caller that leaves the filters empty gets shuffle over the whole library, and one that scopes them
 * gets the next song from that same list. Previously this ALWAYS cleared the filters, so tapping any song
 * anywhere played exactly that song and then stopped dead.
 */
export async function playSpecificSong(songId: string, scope?: SongFilters) {
    // Activating the song that's already current must never restart it: resume if paused, otherwise leave it
    // playing (don't disturb the existing queue/scope). A different song plays fresh from the start.
    if (useActiveSong.getState().songId === songId) {
        if ((await getPlaybackState()).state !== State.Playing) {
            await play();
        }
        return;
    }

    // Deliberately NOT setSongFilters(..., clearAndPlay: true): that starts a RANDOM song from the new scope,
    // which would race the song the user actually tapped. Set the scope, reset the queue/history to it, then
    // start the chosen song.
    await setSongFilters(scope ?? new SongFilters());
    await clear();
    await startNewSong(songId);
}

export async function pause() {
    await TrackPlayer.pause();
}

export async function skip() {
    let recentlyPlayedSong: RecentlyPlayedSong | undefined;
    let songId: string | undefined;

    if (queue.length > 0) {
        const currentSong = await DbQueries.getCurrentlyPlayingSong(db);

        songId = queue.shift();

        if (currentSong != undefined) {
            await DbQueries.removeRecentlyPlayedSongsAfter(db, currentSong?.lastPlayed);
        }
    } else {
        recentlyPlayedSong = await DbQueries.checkForNextRecentlyPlayedSong(db);

        if (recentlyPlayedSong != undefined) {
            songId = recentlyPlayedSong.songId;
        } else {
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

export async function addToQueue(songId: string) {
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

// Single source of truth for applying a like/dislike/love: persist locally and queue the sync push. Shared by
// the in-app RatingControl and the notification's RemoteCustomAction (👍/👎) handler.
export async function applyLikeStatus(songId: string, likeStatus: LikeStatus) {
    const localSessionData = await DbQueries.getActiveLocalSessionData(db);
    if (!localSessionData) {
        return;
    }

    const userId = localSessionData.userId;
    await DbQueries.setUserSongLikeStatus(db, userId, songId, likeStatus);

    const requests: Request[] = [
        {
            requestId: generateId(),
            timeRequested: new Date(),
            requestType: RequestType.SetSongLikeStatus,
            userId,
            songId,
            likeStatus,
        },
    ];

    await DbQueries.addRequests(db, requests);

    // Liking an audition song — or a weak-tagged (Standard-tier / kept) one — is its "promote" signal:
    // enqueue a STRONG re-tag and drop the flags locally so it leaves the audition view / stops
    // re-promoting immediately. enqueueSongRetag keeps one pending row per song with stronger-wins, so a
    // Like landing after a queued Keep upgrades that row instead of double-spending.
    const song = await DbQueries.getSong(db, songId);
    if (song != undefined && shouldPromoteOnLike(song.exploratory, song.tagsStale, likeStatus)) {
        await DbQueries.enqueueSongRetag(db, userId, songId, "strong");
        await DbQueries.markSongPromoted(db, songId);
    }

    // Mirror into the reactive store so any mounted RatingControl for this song updates, regardless of where
    // the change originated (in-app control or the notification's 👍/👎 buttons).
    useLikeStatus.getState().setLikeStatus(songId, likeStatus);

    // Keep the notification 👍/👎 icons in sync when the change is for the currently-playing song.
    if (useActiveSong.getState().songId === songId) {
        await refreshNotificationButtons(likeStatus);
    }
}

/**
 * KEEPS an audition song without liking it: "this can stay, but don't spend premium AI on it." Enqueues a
 * WEAK-model re-tag (the budget tier) and optimistically clears the audition state — with tagsStale set, so
 * the song remains upgradeable: a later like enqueues strong, and if the Keep is still waiting to sync, the
 * outbox's stronger-wins rule upgrades that pending row in place. No-op for non-audition songs.
 */
export async function keepSong(songId: string) {
    const localSessionData = await DbQueries.getActiveLocalSessionData(db);
    if (!localSessionData) {
        return;
    }

    const song = await DbQueries.getSong(db, songId);
    if (song == undefined || !song.exploratory) {
        return;
    }

    await DbQueries.enqueueSongRetag(db, localSessionData.userId, songId, "weak");
    await DbQueries.markSongKept(db, songId);
}

async function startNewSong(songId: string, recentlyPlayedSong?: RecentlyPlayedSong) {
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
        if ((await DbQueries.getRecentlyPlayedSong(db, recentlyPlayedSong.recentlyPlayedSongId)) != undefined) {
            recentlyPlayedSongFound = true;
        }
    }

    if (await Downloader.fileExists(Downloader.generateLocalSongUri(song))) {
        songUri = Downloader.generateLocalSongUri(song);
    } else {
        songUri = await generateUrl(song, false);
    }

    // Album art for the lock-screen / media-notification. Without an `artwork` on the track, Media3 has
    // nothing to render, which is why the notification showed no icon. Prefer the already-downloaded local
    // file (same resolution the Song Info screen uses), fall back to the server URL when it isn't on disk.
    let artworkUri: string;
    const localArtUri = Downloader.generateLocalAlbumArtUri(song);
    if (await Downloader.fileExists(localArtUri)) {
        artworkUri = localArtUri;
    } else {
        artworkUri = await Downloader.generateServerAlbumArtUrl(song);
    }

    await clearSong();
    await TrackPlayer.add([{
        id: songId,
        url: songUri,
        title: song.name,
        artist: songWithArtist.artists.length > 0 ? songWithArtist.artists.map(x => x.name).join(", ") : "Unknown Artist",
        artwork: artworkUri,
    }]);
    await TrackPlayer.play();

    const timeSongStarted = new Date(Date.now());

    // Update state
    useActiveSong.getState().setSongId(songId);

    if (recentlyPlayedSongFound) {
        const timestampSeconds = recentlyPlayedSong?.timestampSeconds ?? 0;
        await TrackPlayer.seekTo(timestampSeconds);
        await DbQueries.setRecentlyPlayedSongTimestampSeconds(db, recentlyPlayedSong?.recentlyPlayedSongId!, timestampSeconds);
    } else {
        await DbQueries.addRecentlyPlayedSong(db, {
            songId: songId,
            recentlyPlayedSongId: generateId(),
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
            requestId: generateId(),
            timeRequested: timeSongStarted,
            requestType: RequestType.CreateUserSong
        };
        
        userSong = {
            userId: newUserSongRequest.userId,
            songId: newUserSongRequest.songId,
            lastPlayed: newUserSongRequest.timeRequested,
            version: newUserSongRequest.timeRequested,
            likeStatus: LikeStatus.Neutral
        };
        await DbQueries.addUserSong(db, userSong);
        await DbQueries.addRequests(db, [newUserSongRequest]);
    }

    const updateSongLastPlayedRequest: UpdateSongLastPlayedRequest = {
        requestId: generateId(),
        lastPlayed: timeSongStarted,
        songId: songId,
        timeRequested: timeSongStarted,
        requestType: RequestType.UpdateSongLastPlayed,
        userId: localSessionData.userId
    };
    await DbQueries.updateUserSongLastPlayed(db, localSessionData.userId, songId, timeSongStarted);
    await DbQueries.addRequests(db, [updateSongLastPlayedRequest]);

    // Reflect the new active song's saved like state on the notification buttons.
    await refreshNotificationButtons((userSong.likeStatus as LikeStatus) ?? LikeStatus.Neutral);
}

async function getRandomSongId(): Promise<string | undefined> {
    const songFilters = await getSongFilters();
    let songId: string | undefined;

    if (songFilters.hasAnyFilter()) {
        const filteredSongs = await DbQueries.getFilteredSong(db, songFilters);

        if (!filteredSongs.length) {
            return undefined;
        }

        const percentage = 0.3;
        const percentageUpperBoundIndex = filteredSongs.length * percentage;
        const nullUpperBoundIndex = filteredSongs.findIndex(x => x.lastPlayed != null) ?? 0;
        const upperBoundIndex = Math.max(percentageUpperBoundIndex, nullUpperBoundIndex);
        const randomSongIndex = Math.floor(upperBoundIndex * Math.random());

        songId = filteredSongs[randomSongIndex].songId;
    } else {
        // No scope set => shuffle the whole library rather than stopping. This used to return undefined, which
        // made playback halt after a single song whenever the filters happened to be empty — the same dead end
        // reached from any list screen, since those cleared the filters on the way in.
        songId = await DbQueries.getRandomSongId(db);
    }

    return songId;
}
