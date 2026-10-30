import { GenericDb } from "../db/GenericDb";
import TrackPlayer, { Capability, Event, PlaybackState, RemoteSeekEvent, State, usePlaybackState } from "react-native-track-player";
import { RecentlyPlayedSong, Song } from "../db/models";
import DbQueries from "../db/queries";
import { shouldSkipOnDislike } from "../../tools/promotion";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { generateRange, generateId } from "../../tools/utils";
import { LikeStatus } from "../../enums";
import { getPlaybackState } from "react-native-track-player/lib/src/trackPlayer";
import { Downloader } from "../downloader/Downloader";
import { create } from "zustand";
import path from "path-browserify";
import { SongFilters, SongFilterType } from "../../types/SongFilters";
import { asIfJustPlayed, selectNextSong, ShuffleCandidate } from "../../tools/shuffle";
import { Lookahead } from "../../tools/lookahead";
import { prefetcher } from "../prefetch/Prefetcher";
import { loadPrefetchSetting, savePrefetchSetting, usePrefetchSetting } from "../prefetch/prefetchSetting";
import { addNetworkStateListener } from "expo-network";
import {
    classifyPlaybackError,
    decidePlaybackRecovery,
    PlaybackErrorLike,
} from "../../tools/playbackFailure";
import { Platform } from "react-native";
import { createSerialLock } from "../../tools/serialLock";
import { playerSetupOptions } from "../../tools/playerSetup";
import { SongDetails } from "../db/types";

let queue: string[] = [];
let db: GenericDb;
let trackPlayerInitialized = false;
// ── failure recovery ─────────────────────────────────────────────────────────────────────────────────────
// A track that fails to load is NOT automatically a track worth skipping - see tools/playbackFailure.ts for
// why the two mistakes here are not symmetric. This module holds the state that decision needs; the decision
// itself is pure and lives there so it can be tested.

// Whether the track currently handed to the player came off local storage rather than the network. The
// strongest signal available for classifying a failure, and worth more than any error code: a file already on
// disk cannot fail because the connection did.
let activeSourceIsLocal = false;
// The URL the current track is streaming from, when it is not local. Probed after an inconclusive failure to
// learn the HTTP status the error event does not carry.
let activeStreamUrl: string | undefined;
// The user has paused, and nothing automatic may start audio again until they press play. Recovery used to
// override this: a retry already in flight, or the next failure event, would restart or skip the song seconds
// after the user had stopped it, which made a stall impossible to get out of without closing the app.
let userPaused = false;
// Failed attempts at the CURRENT track since it last played. Cleared whenever a track starts or plays.
let trackRetryAttempts = 0;
// The song the player is stalled on, waiting out a fault that looks environmental. Set for as long as we are
// prepared to resume it - INCLUDING after the retry timer has given up, because connectivity returning is
// still a good reason to carry on, and that can happen long after the last scheduled attempt.
let stalledSongId: string | undefined;
// Cancellation token for a scheduled retry. Every track change and every user action bumps it, so a timer
// that fires late cannot restart a song the user has already moved on from.
let recoveryEpoch = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let networkRecoverySubscribed = false;
// play, pause, skip, previous and every other track change run one at a time through this (ShuffullApp#22). Each
// reads the current song and playback state, then awaits the database and the player several times before it
// writes; two at once interleave at every await. Two quick skips both read the same current song and both rewrite
// the recently-played rows, and a pause during a skip is undone when that skip starts the next track. Every
// transport call returns once playback is REQUESTED (native RNTP, and the web shim's requestPlay), so nothing
// holds the lock while a stream buffers. The exported functions take the lock; code already holding it calls the
// `...Locked` bodies, since it isn't re-entrant.
const transportLock = createSerialLock({ name: "player" });
// The next songs skip() will play, decided while the current one plays so the prefetcher can fetch them first
// (ShuffullApp#124). Off (the setting, or a platform with no prefetcher), nothing is reserved and skip() shuffles at
// the moment of the skip, exactly as it always has.
const lookahead = new Lookahead({
    current: () => useActiveSong.getState().songId,
    queue: () => queue,
    forwardHistory: async (limit) => (await DbQueries.getNextRecentlyPlayedSongs(db, limit)).map(x => x.songId),
    pick: (played) => pickShuffleSong(played),
    isEligible: (songId) => isShuffleEligible(songId),
});
// How many times a whole-library pick re-rolls to avoid a song already lined up, before taking it anyway.
const LIBRARY_PICK_ATTEMPTS = 3;
let lookaheadRefreshRunning = false;
let lookaheadRefreshAgain = false;

/**
 * Audition mode (ShuffullApp#125) while its screen is open. The deck decides what plays next, so every way of moving
 * the player on - next, previous, play, a song ending, the notification's buttons - goes to it instead of to the
 * shuffle. The shuffle's skip() would start the next song through startNewSong, which stamps it as played at once:
 * the very thing audition mode exists not to do.
 */
export interface AuditionController {
    resume(): Promise<void>;
    next(): Promise<void>;
    previous(): Promise<void>;
    rate(likeStatus: LikeStatus): Promise<void>;
    keep(): Promise<void>;
    onPlaybackState(playing: boolean): void;
    onEnded(songId: string | undefined): Promise<void>;
}

let auditionController: AuditionController | undefined;
// How long a start at the start point waits for the track's length before playing it from the top instead.
const START_POINT_WAIT_MS = 1_500;
// How much longer it keeps trying to jump to the start point after that, while the song is still near its start.
const START_POINT_LATE_SEEK_MS = 8_000;

interface ActiveSongState {
    songId: string | undefined;
    setSongId: (songId: string | undefined) => void;
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
    if (!clearAndPlay) {
        await saveSongFilters(songFilters);
        // Songs picked from the old scope are not what the next skip would pick from the new one.
        lookahead.reset();
        scheduleLookaheadRefresh();
        return;
    }

    // A new scope is a track change. Inside the lock, so a skip still running can't pick its song from the new
    // scope and then have it cleared away from under it.
    await transportLock.run(async () => {
        await saveSongFilters(songFilters);
        await clear();
        await playLocked();
    });
}

async function saveSongFilters(songFilters: SongFilters) {
    await AsyncStorage.setItem(STORAGE_KEYS.CURRENT_SONG_FILTERS, JSON.stringify(songFilters));
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

/**
 * Why playback is not making progress, so the UI can say so.
 *
 * The incident this came from was silent: songs advanced on their own, with nothing on screen to explain it.
 * Waiting on the same song is the right behaviour, but waiting INVISIBLY just looks broken - it is the same
 * complaint in a different shape. Undefined means playback is healthy.
 */
export type PlaybackIssue = {
    kind: "reconnecting" | "offline" | "unplayable";
    songId: string | undefined;
};

/**
 * What the player shows in place of its usual caption while there is an issue. Waiting on a song looks like a
 * hang unless it says so, and since a failed song is never skipped automatically, "unplayable" is the user's
 * cue to skip it themselves.
 */
export const PLAYBACK_ISSUE_LABEL: Record<PlaybackIssue["kind"], string> = {
    reconnecting: "Reconnecting…",
    offline: "Waiting for connection",
    unplayable: "Can't play this song",
};

interface PlaybackIssueState {
    issue: PlaybackIssue | undefined;
    setIssue: (issue: PlaybackIssue | undefined) => void;
}

export const usePlaybackIssue = create<PlaybackIssueState>((set) => ({
    issue: undefined,
    setIssue: (issue) => set({ issue }),
}));

interface SongStateRevisionState {
    // Bumped after every local write that can change a song's audition state: a song starting (lastPlayed), a
    // like/dislike, a Keep. Screens that derive per-song states read it to re-derive them while open; before,
    // the playlist screen computed its "N/M evaluated" once on mount and only moved when it was re-opened.
    revision: number;
    bump: () => void;
}

export const useSongStateRevision = create<SongStateRevisionState>((set) => ({
    revision: 0,
    bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

interface AuditionFinishedState {
    // The audition playlist playback just stopped at the end of, so the player bar can say why it went quiet.
    // Cleared when the next song starts.
    playlistId: string | undefined;
    setPlaylistId: (playlistId: string | undefined) => void;
}

export const useAuditionFinished = create<AuditionFinishedState>((set) => ({
    playlistId: undefined,
    setPlaylistId: (playlistId) => set({ playlistId }),
}));

export async function setup(activeDb: GenericDb) {
    db = activeDb;
    initTrackPlayer();
    await loadPrefetchSetting();

    const currentlyPlayingSong = await DbQueries.getCurrentlyPlayingSong(db);

    if (currentlyPlayingSong != undefined) {
        useActiveSong.getState().setSongId(currentlyPlayingSong.songId);
    }
}

// Notification 👍/👎 button icon indices. The withNotificationActionIcons config plugin overrides the fork's
// built-in icon slots with thumb variants: 0 = thumb-up outline, 1 = thumb-up solid, 2 = thumb-down outline,
// 3 = thumb-down solid — so each button shows solid when its state is active and outline otherwise.
function buildPlayerOptions(likeStatus: LikeStatus, canKeep = false) {
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
    // The system media panel draws FIVE buttons and no more (measured, One UI 8.5 / Android 16 — a sixth is
    // dropped in silence). It builds them from the LEGACY PlaybackState: prev/play-pause/next come from the
    // actions bitmask, the rest from customActions. Media3's slot API does not reach it, so the only way to
    // free a slot for Keep is to stop advertising SkipToPrevious — which is done for audition songs only.
    // The command stays in `capabilities`, so headset/Bluetooth/Auto "previous" is unaffected; it is purely
    // the drawn button that Keep takes over.
    const notificationTransport = canKeep
        ? transport.filter(capability => capability !== Capability.SkipToPrevious)
        : transport;

    return {
        capabilities: transport,
        compactCapabilities: transport,
        notificationCapabilities: notificationTransport,
        // Media3 custom notification buttons (lovegaoshi RNTP fork): always-visible 👍/👎. The like button
        // cycles neutral → Like → Love (icons 0 → 1 → 4) and 👎 toggles dislike (2 ↔ 3), via the
        // RemoteCustomAction handler. (The fork's { uri } icon path doesn't resolve reliably on our stack.)
        // Keep (bookmark, icon 5) is CONDITIONAL: it only means anything for an un-vetted audition song, and
        // keeping one clears `exploratory`, so the button disappears as soon as it has been used. It occupies
        // the slot freed above, which is why it lands exactly where "previous" is drawn on a normal song.
        customActions: {
            // Order is NOT display order. The panel fills its outer slots from this list as
            // [1]→leftmost, [0]→second, [2]→rightmost (measured). So "keep, like, dislike" renders as
            // 👍 🔖 ⏸ ⏭ 👎 — identical to a non-audition song's 👍 ⏮ ⏸ ⏭ 👎 with the bookmark standing exactly
            // where "previous" was. The thumbs therefore never move between audition and normal songs, which
            // is the same mis-tap hazard the in-app likes row was fixed for: dislike skips the song and Keep
            // is one-way, so a swap under muscle memory is expensive.
            customActionsList: canKeep ? ["keep", "like", "dislike"] : ["like", "dislike"],
            like: likeIcon,
            dislike: disliked ? 3 : 2,
            keep: 5,
        },
    };
}

// Reflect a song's like state on the notification's 👍/👎 buttons. Safe to call repeatedly; updateOptions
// re-applies the custom layout. Meaningful only for the active track.
async function refreshNotificationButtons(likeStatus: LikeStatus, canKeep = false) {
    try {
        await TrackPlayer.updateOptions(buildPlayerOptions(likeStatus, canKeep));
    } catch {
        // Non-critical: the notification buttons are best-effort.
    }
}

async function initTrackPlayer() {
    try {
        await TrackPlayer.getActiveTrack(); // error if not set up
    } catch {
        TrackPlayer.registerPlaybackService(() => setupEventListeners);
        await TrackPlayer.setupPlayer(playerSetupOptions(Platform.OS)); // TODO: ensure safety for this to be run when app is in foreground
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
            await rateActiveSong(activeSongId, next);
        } else if (event.customAction === "dislike") {
            await rateActiveSong(activeSongId, current === LikeStatus.Dislike ? LikeStatus.Neutral : LikeStatus.Dislike);
        } else if (event.customAction === "keep") {
            // One-way, and a no-op for anything that isn't an audition song (keepSong guards on that itself).
            await keepActiveSong(activeSongId);
            // keepSong clears `exploratory`, so the button has done its job — take it back off the notification.
            await refreshNotificationButtons(current, false);
        }
    });
    TrackPlayer.addEventListener(Event.PlaybackState, async (state: PlaybackState) => {
        // A track reaching the speakers is the only proof that BOTH the source and the path to it are good, so
        // it is what clears the retry budget and any flag on screen.
        auditionController?.onPlaybackState(state.state == State.Playing);

        if (state.state == State.Playing) {
            clearStall();
            return;
        }

        if (state.state != State.Ended) {
            return;
        }

        if (auditionController) {
            await auditionController.onEnded(useActiveSong.getState().songId);
            return;
        }

        await skipFrom(useActiveSong.getState().songId);
    });
    // A track that FAILS to load lands in State.Error, not State.Ended, so the handler above never fires and
    // playback just stops dead with nothing logged -- which is how a song deleted server-side, a dropped
    // network and a corrupt file all presented.
    TrackPlayer.addEventListener(Event.PlaybackError, async (error) => await handlePlaybackFailure(error));
    subscribeToNetworkRecovery();
}

/**
 * Normalises the error event into the { code, message } pair the classifier wants.
 *
 * Android emits exactly that. iOS does NOT: `handleAudioPlayerFailed` sends `{ error: <localizedDescription> }`
 * with no code at all, and the code only reaches JS through the PLAYBACK STATE payload
 * (`getPlaybackStateErrorKeyValues`). Reading it back from there is the difference between classifying an iOS
 * "not connected to the internet" correctly and lumping every iOS failure into unknown.
 */
async function describePlaybackError(raw: unknown): Promise<PlaybackErrorLike> {
    const event = (raw ?? {}) as { code?: string; message?: string; error?: unknown };
    const eventMessage = event.message ?? (typeof event.error === "string" ? event.error : undefined);

    if (typeof event.code === "string" && event.code.length > 0) {
        return { code: event.code, message: eventMessage };
    }

    try {
        const state = await getPlaybackState() as { error?: { code?: string; message?: string } };
        if (state.error?.code) {
            return { code: state.error.code, message: state.error.message ?? eventMessage };
        }
    } catch {
        // Player unavailable - fall through to whatever the event itself carried.
    }

    return { code: undefined, message: eventMessage };
}

async function handlePlaybackFailure(raw: unknown) {
    // Supersede any retry already queued for this track: this failure is the newer information.
    cancelScheduledRetry();

    const songId = useActiveSong.getState().songId;
    const error = await describePlaybackError(raw);
    let kind = classifyPlaybackError(error, { isLocalSource: activeSourceIsLocal });
    let probedStatus: number | "unreachable" | undefined;

    if (kind === "unknown" && activeStreamUrl != undefined) {
        const epoch = recoveryEpoch;
        probedStatus = await probeStreamStatus(activeStreamUrl);

        // The probe can take seconds. A skip or a new song in that window has made this failure stale, and
        // acting on it would retry or flag the song the user has just moved to.
        if (epoch !== recoveryEpoch) {
            return;
        }

        kind = classifyPlaybackError(error, { isLocalSource: activeSourceIsLocal, probedStatus });
    }

    if (userPaused) {
        // Recorded, not acted on. The user has stopped playback; retrying now would override that.
        console.warn(`[player] ${kind} playback failure on song ${songId} while paused - leaving it paused.`);
        return;
    }

    const recovery = decidePlaybackRecovery({ kind, attempt: trackRetryAttempts });

    console.warn(
        `[player] ${kind} playback failure on song ${songId} ` +
        `(code=${error.code ?? "none"}, source=${activeSourceIsLocal ? "local" : "stream"}, ` +
        `probe=${probedStatus ?? "none"}, ` +
        `attempt=${trackRetryAttempts}) -> ${recovery.action}: ${error.message ?? "no message"}`);

    if (recovery.action === "retry") {
        trackRetryAttempts++;
        stalledSongId = songId;
        usePlaybackIssue.getState().setIssue({ kind: "reconnecting", songId });
        scheduleRetry(recovery.delayMs);
        return;
    }

    if (recovery.reason === "offline") {
        // The timer gives up; the recovery does not. stalledSongId stays set, so the network coming back
        // resumes THIS song - which is the whole point of never having skipped it.
        stalledSongId = recovery.resumeOnReconnect ? songId : undefined;
        console.warn("[player] still unreachable - waiting for the connection to come back before retrying.");
        usePlaybackIssue.getState().setIssue({ kind: "offline", songId });
        return;
    }

    // Stopped on this song, never skipped past it: play retries it, next moves on, both the user's call.
    console.warn("[player] song can't be played - stopped on it until the user retries or skips.");
    stalledSongId = recovery.resumeOnReconnect ? songId : undefined;
    usePlaybackIssue.getState().setIssue({ kind: "unplayable", songId });
}

const PROBE_TIMEOUT_MS = 8_000;

/**
 * Asks the stream URL directly what the player could not tell us. A HEAD is enough: the static file handler
 * answers it with the same status a GET would get, and Cloudflare answers it with the same 530 when the tunnel
 * is down. Never throws - not getting an answer at all is itself the answer.
 */
async function probeStreamStatus(url: string): Promise<number | "unreachable"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
        const response = await fetch(url, { method: "HEAD", signal: controller.signal });
        return response.status;
    } catch {
        return "unreachable";
    } finally {
        clearTimeout(timeout);
    }
}

/** Drops any queued retry and invalidates in-flight ones. Every track change and user action goes through it. */
function cancelScheduledRetry() {
    recoveryEpoch++;

    if (retryTimer != undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
    }
}

/** Back to healthy: nothing pending, no stall, nothing for the UI to report. */
function clearStall() {
    cancelScheduledRetry();
    trackRetryAttempts = 0;
    stalledSongId = undefined;
    usePlaybackIssue.getState().setIssue(undefined);
}

function scheduleRetry(delayMs: number) {
    const epoch = recoveryEpoch;
    retryTimer = setTimeout(async () => {
        retryTimer = undefined;

        if (epoch !== recoveryEpoch) {
            return;
        }

        await retryCurrentTrack();
    }, delayMs);
}

/**
 * Re-prepares the track ALREADY loaded, rather than starting a new one.
 *
 * That distinction is the fix. `startNewSong` stamps `user_songs.last_played` and queues an
 * `UpdateSongLastPlayed` to the server, so routing recovery through it would record a song as played every
 * time the connection wobbled. `TrackPlayer.retry()` is `player.prepare()` on the existing item: it resumes
 * from the same position and writes nothing.
 */
async function retryCurrentTrack() {
    const epoch = recoveryEpoch;

    try {
        await TrackPlayer.retry();

        // A pause landing while retry() was in flight has already cancelled this recovery; starting audio now
        // would undo it.
        if (epoch !== recoveryEpoch || userPaused) {
            return;
        }

        await TrackPlayer.play();
    } catch (error) {
        console.warn("[player] could not restart the stalled track:", error);
    }
}

/**
 * Resumes a stalled song the moment the device has a connection again, instead of waiting out the rest of the
 * backoff - or, once the retry budget is spent, instead of not resuming at all. This is what makes walking
 * back into signal recover on its own.
 */
function subscribeToNetworkRecovery() {
    if (networkRecoverySubscribed) {
        return;
    }

    networkRecoverySubscribed = true;
    addNetworkStateListener(({ isInternetReachable }) => {
        if (isInternetReachable !== true || stalledSongId == undefined) {
            return;
        }

        console.info(`[player] connection is back - resuming song ${stalledSongId}.`);
        cancelScheduledRetry();
        // A fresh budget: the reason the old one ran out has demonstrably changed.
        trackRetryAttempts = 0;
        usePlaybackIssue.getState().setIssue({ kind: "reconnecting", songId: stalledSongId });
        void retryCurrentTrack();
    });
}

/**
 * Called by everything the USER initiates. A person pressing play, next or previous is new information, and
 * it must not inherit a budget that some earlier outage exhausted - otherwise the player stays wedged after
 * the cause is long gone.
 */
function beginUserInitiatedPlayback() {
    userPaused = false;
    clearStall();
}

export function play(): Promise<void> {
    if (auditionController) {
        return auditionController.resume();
    }
    return transportLock.run(playLocked);
}

async function playLocked() {
    beginUserInitiatedPlayback();
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

    // Pressing play on a track that FAILED means "try that again", not "give up on it". Without this branch
    // State.Error falls through to the else below and skips - so the one gesture a user makes to recover from
    // a stall was the gesture that lost them the song, which is the same mistake the error handler used to
    // make automatically.
    if (hasTrack && playbackState == State.Error) {
        await retryCurrentTrack();
        return;
    }

    // Loading and Buffering are a track already on its way, not a reason to move on. They used to fall through
    // to the skip below, so pressing the button on a song that was stuck loading skipped it.
    if (hasTrack && (playbackState == State.Paused || playbackState == State.Ready || playbackState == State.Playing
        || playbackState == State.Loading || playbackState == State.Buffering)) {
        await TrackPlayer.play();
    } else if (playbackState == State.None) {
        const currentlyPlayingSong = await getCurrentlyPlayingSong();

        if (currentlyPlayingSong != null) {
            await startNewSong(currentlyPlayingSong.songId, currentlyPlayingSong);
        } else {
            await skipLocked();
        }
    } else {
        await skipLocked();
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
export function playSpecificSong(songId: string, scope?: SongFilters): Promise<void> {
    return transportLock.run(() => playSpecificSongLocked(songId, scope));
}

async function playSpecificSongLocked(songId: string, scope?: SongFilters) {
    beginUserInitiatedPlayback();

    // Activating the song that's already current must never restart it: resume if paused, otherwise leave it
    // playing (don't disturb the existing queue/scope). A different song plays fresh from the start.
    if (useActiveSong.getState().songId === songId) {
        if ((await getPlaybackState()).state !== State.Playing) {
            await playLocked();
        }
        return;
    }

    // Deliberately NOT setSongFilters(..., clearAndPlay: true): that starts a RANDOM song from the new scope,
    // which would race the song the user actually tapped. Set the scope, reset the queue/history to it, then
    // start the chosen song.
    await saveSongFilters(scope ?? new SongFilters());
    await clear();
    await startNewSong(songId);
}

/**
 * Whether the play/pause control should read as "pause": audio is playing or on its way. That includes a stall
 * the player is still retrying - from the user's side it is trying to play, and the one thing they need from
 * the button then is to make it stop. The old toggles checked for State.Playing alone, so during a stall the
 * pause button called play(), which skipped the song.
 */
export function isPlaybackActive(state: State | undefined, issue: PlaybackIssue | undefined): boolean {
    return state == State.Playing || state == State.Buffering || state == State.Loading || issue?.kind == "reconnecting";
}

/** Live `isPlaybackActive`, for drawing the play/pause glyph from the same rule `togglePlayback` acts on. */
export function useIsPlaybackActive(): boolean {
    const { state } = usePlaybackState();
    const { issue } = usePlaybackIssue();
    return isPlaybackActive(state, issue);
}

export function togglePlayback(): Promise<void> {
    // The state is read INSIDE the lock, so a double tap toggles twice: the second tap sees what the first one
    // left, rather than both reading "playing" and both pausing.
    const controller = auditionController;
    return transportLock.run(async () => {
        const state = (await getPlaybackState()).state;

        if (isPlaybackActive(state, usePlaybackIssue.getState().issue)) {
            await pauseLocked();
        } else if (controller) {
            // Not awaited: the deck's resume takes this lock itself.
            void controller.resume();
        } else {
            await playLocked();
        }
    });
}

export function pause(): Promise<void> {
    return transportLock.run(pauseLocked);
}

async function pauseLocked() {
    userPaused = true;
    // Disarms recovery. A retry queued for a stalled song would otherwise fire seconds later and start audio
    // the user has just stopped - and so would the network-came-back listener, at any point afterwards.
    // Pausing is a decision to stop waiting; play() re-prepares the same track rather than skipping it.
    clearStall();
    await TrackPlayer.pause();
}

/**
 * Every caller is a person or a finished song. A failed load never calls this (ShuffullApp#103): the player
 * stops and flags the song instead, and moving on is left to the user.
 */
export function skip(): Promise<void> {
    if (auditionController) {
        return auditionController.next();
    }
    return transportLock.run(skipLocked);
}

/**
 * Skips off `songId` only if it is still the current song once the lock is free. For skips the player decides on
 * (a song ending, a dislike): their reason applies to the song that was current when they were decided. Queued
 * behind a user's skip, a plain skip() would move straight off the song the user had just picked, and stamp it
 * as played.
 */
function skipFrom(songId: string | undefined): Promise<void> {
    return transportLock.run(async () => {
        if (useActiveSong.getState().songId !== songId) {
            return;
        }

        await skipLocked();
    });
}

async function skipLocked() {
    beginUserInitiatedPlayback();

    if (await stopIfAuditionFinished()) {
        return;
    }

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
            // The song lined up ahead, when there is one and it may still play; otherwise a fresh pick, as before.
            songId = (isLookaheadEnabled() ? await lookahead.takePick() : undefined) ?? await getRandomSongId();
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

/**
 * Stops instead of moving on when the song just heard (or skipped, or disliked away) finished an audition mix,
 * so the user can tell they are done with it and go to the next one. Without this the pool quietly fell back to
 * replaying heard songs (see getFilteredSong) and nothing marked the end.
 *
 * Only for an audition scope: the rule keys off `unheardOnly`, which ordinary playlists never set. Fires once:
 * the flag is cleared here, so pressing play or next afterwards carries on exactly as before.
 */
async function stopIfAuditionFinished(): Promise<boolean> {
    const inProgress = await getAuditionInProgress();
    if (inProgress == undefined) {
        return false;
    }

    const sessionData = await DbQueries.getActiveLocalSessionData(db);
    const finishedPlaylistId = sessionData
        ? await DbQueries.getFinishedAuditionToStopFor(db, sessionData.userId, await getSongFilters(), inProgress)
        : undefined;
    if (finishedPlaylistId == undefined) {
        return false;
    }

    await setAuditionInProgress(undefined);
    userPaused = true;
    clearStall();
    // A song that ENDED has nothing left to pause, and pausing it would leave play() resuming at its very end.
    // One the user skipped or disliked away is still playing, so it stops where it is.
    if ((await getPlaybackState()).state !== State.Ended) {
        await TrackPlayer.pause();
    }
    useAuditionFinished.getState().setPlaylistId(finishedPlaylistId);
    return true;
}

// The audition that was unfinished when the current song started; what lets skip() stop exactly once, on the song
// that finishes the mix. In storage rather than memory so a restart mid-song doesn't lose it.
async function getAuditionInProgress(): Promise<string | undefined> {
    return (await AsyncStorage.getItem(STORAGE_KEYS.AUDITION_IN_PROGRESS)) ?? undefined;
}

async function setAuditionInProgress(playlistId: string | undefined) {
    if (playlistId == undefined) {
        await AsyncStorage.removeItem(STORAGE_KEYS.AUDITION_IN_PROGRESS);
    } else {
        await AsyncStorage.setItem(STORAGE_KEYS.AUDITION_IN_PROGRESS, playlistId);
    }
}

export function previous(): Promise<void> {
    if (auditionController) {
        return auditionController.previous();
    }
    return transportLock.run(previousLocked);
}

async function previousLocked() {
    beginUserInitiatedPlayback();
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
        // A queued song plays before any shuffle pick, so it takes a slot in the lookahead.
        scheduleLookaheadRefresh();
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

    // Before anything else: a retry armed for the song being cleared would otherwise fire into an empty player.
    clearStall();
    clearQueue();
    lookahead.reset();
    // Nothing plays after a clear until a new song starts (on logout, never), so stop the old list's fetch now.
    prefetcher.want([]);
    // A new scope is a fresh start: pressing Play on a mix that has just finished must play, not stop again.
    await setAuditionInProgress(undefined);
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

    // The rating, its outbox row and, for a Like of an audition or weak-tagged song, the strong re-tag that promotes
    // it, all in one transaction (recordLikeStatus).
    const { song, promoted } = await DbQueries.recordLikeStatus(db, localSessionData.userId, songId, likeStatus);

    // Mirror into the reactive store so any mounted RatingControl for this song updates, regardless of where
    // the change originated (in-app control or the notification's 👍/👎 buttons).
    useLikeStatus.getState().setLikeStatus(songId, likeStatus);
    useSongStateRevision.getState().bump();

    // Keep the notification 👍/👎 icons in sync when the change is for the currently-playing song.
    const isActiveSong = useActiveSong.getState().songId === songId;
    if (isActiveSong) {
        // Liking an audition song promotes it, which clears `exploratory` — so Keep is no longer offered,
        // and the button has to go in the same refresh rather than lingering until the next track.
        await refreshNotificationButtons(likeStatus, (song?.exploratory ?? false) && !promoted);
    }

    // A disliked song is out of the shuffle, so a pick lined up for it is no longer what skip() would play.
    if (likeStatus === LikeStatus.Dislike && lookahead.forget(songId)) {
        scheduleLookaheadRefresh();
    }

    // Disliking what is playing moves off it immediately. Deliberately LAST: skip() starts the next song and
    // refreshes the notification for it, so anything above that still refers to the outgoing song must
    // already have been written.
    const playbackState = (await getPlaybackState()).state;
    const isPlaying = playbackState === State.Playing || playbackState === State.Buffering || playbackState === State.Loading;
    if (shouldSkipOnDislike(isActiveSong, likeStatus, isPlaying, auditionController != undefined)) {
        await skipFrom(songId);
    }
}

/**
 * KEEPS an audition song without liking it: "this can stay, but don't spend premium AI on it." Enqueues a
 * WEAK-model re-tag (the budget tier) and optimistically clears the audition state — with tagsStale set, so
 * the song remains upgradeable: a later like enqueues strong, and if the Keep is still waiting to sync, the
 * outbox's stronger-wins rule upgrades that pending row. No-op for non-audition songs.
 */
export async function keepSong(songId: string) {
    const localSessionData = await DbQueries.getActiveLocalSessionData(db);
    if (!localSessionData) {
        return;
    }

    if (await DbQueries.recordKeep(db, localSessionData.userId, songId)) {
        useSongStateRevision.getState().bump();
    }
}

/**
 * Rates the song that is playing, from anywhere outside the screens (notification, desktop shortcuts). While audition
 * mode is open it goes through the deck, which moves on after a Dislike and counts the verdict; otherwise it is
 * applyLikeStatus.
 */
export function rateActiveSong(songId: string, likeStatus: LikeStatus): Promise<void> {
    return auditionController ? auditionController.rate(likeStatus) : applyLikeStatus(songId, likeStatus);
}

/** Keeps the song that is playing, through the deck while audition mode is open (rateActiveSong). */
export function keepActiveSong(songId: string): Promise<void> {
    return auditionController ? auditionController.keep() : keepSong(songId);
}

/**
 * Hands the player to audition mode for `playlistId`. Clears what was playing, and scopes the normal player to the
 * mix's unheard songs, so Play after leaving the deck carries on with the mix the ordinary way.
 */
export function beginAuditionMode(playlistId: string, controller: AuditionController): Promise<void> {
    return transportLock.run(async () => {
        const scope = new SongFilters();
        scope.setSoleFilter(SongFilterType.Playlist, [playlistId]);
        scope.unheardOnly = true;
        await saveSongFilters(scope);
        await clear();
        auditionController = controller;
        auditionLoadEpoch++;
    });
}

/**
 * Gives the player back. Stops and unloads the deck's song: nothing recorded it as playing (that was the point), so
 * the normal player must not pick it up half-way and play on from it unrecorded. The player bar goes with it, rather
 * than show a song that is no longer loaded.
 */
export function endAuditionMode(controller: AuditionController): Promise<void> {
    return transportLock.run(async () => {
        if (auditionController !== controller) {
            return;
        }
        auditionController = undefined;
        auditionLoadEpoch++;
        userPaused = true;
        clearStall();
        try {
            await TrackPlayer.pause();
        } catch {
            // Never set up (web without a session): nothing to stop.
        }
        await clear();
        useActiveSong.getState().setSongId(undefined);
        scheduleLookaheadRefresh();
    });
}

// Bumped by every audition load, so a late jump to the start point never lands on a song the deck has moved past.
let auditionLoadEpoch = 0;

/**
 * Starts `songId` at `startFraction` of its length for audition mode. Unlike startNewSong it writes NOTHING: no
 * lastPlayed stamp, no history row, no audition-in-progress marker. A song flicked past in two seconds has to stay
 * unheard, and only markAuditionHeard (called once the heard rule is met) records it as played.
 */
export function playAuditionSong(songId: string, startFraction: number): Promise<void> {
    return transportLock.run(async () => {
        // A deck step still queued when the screen closed: the player is no longer the deck's to drive.
        if (auditionController == undefined) {
            return;
        }
        beginUserInitiatedPlayback();
        const epoch = ++auditionLoadEpoch;
        const songWithArtist = await DbQueries.fetchSongDetails(db, songId);
        await loadTrack(songWithArtist);
        useActiveSong.getState().setSongId(songId);
        useAuditionFinished.getState().setPlaylistId(undefined);

        if (startFraction > 0) {
            const duration = await waitForDuration(START_POINT_WAIT_MS);
            if (duration > 0) {
                await TrackPlayer.seekTo(duration * startFraction);
            } else {
                // The length isn't known yet (a slow stream): start it now and jump once it is, rather than hold
                // every other control up behind the wait.
                void seekToStartPointLate(epoch, startFraction);
            }
        }
        await TrackPlayer.play();

        const sessionData = await DbQueries.getActiveLocalSessionData(db);
        const userSong = sessionData ? await DbQueries.getUserSong(db, sessionData.userId, songId) : undefined;
        await refreshNotificationButtons((userSong?.likeStatus as LikeStatus) ?? LikeStatus.Neutral, songWithArtist.song.exploratory);
    });
}

async function waitForDuration(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const { duration } = await TrackPlayer.getProgress();
        if (duration > 0 || Date.now() >= deadline) {
            return duration;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function seekToStartPointLate(epoch: number, startFraction: number) {
    const deadline = Date.now() + START_POINT_LATE_SEEK_MS;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (epoch !== auditionLoadEpoch) {
            return;
        }
        const { duration, position } = await TrackPlayer.getProgress();
        if (duration > 0) {
            // Only while the song is still near its top: past that, the user has scrubbed or chosen From the start.
            if (position < 5) {
                await transportLock.run(async () => {
                    if (epoch === auditionLoadEpoch) {
                        await TrackPlayer.seekTo(duration * startFraction);
                    }
                });
            }
            return;
        }
    }
}

/** Resumes the deck's paused song where it is. Never moves on to another: the deck decides that. */
export function auditionResume(): Promise<void> {
    return transportLock.run(async () => {
        if (auditionController == undefined) {
            return;
        }
        beginUserInitiatedPlayback();
        if ((await getPlaybackState()).state == State.Error) {
            await retryCurrentTrack();
            return;
        }
        await TrackPlayer.play();
    });
}

export function auditionPause(): Promise<void> {
    return transportLock.run(pauseLocked);
}

/** Records an auditioned song as played, once the heard rule says it was heard. */
export async function markAuditionHeard(songId: string): Promise<void> {
    const sessionData = await DbQueries.getActiveLocalSessionData(db);
    if (!sessionData) {
        throw new Error("No local session data found in markAuditionHeard");
    }
    await DbQueries.recordPlayed(db, sessionData.userId, songId, new Date());
    useSongStateRevision.getState().bump();
}

/** Lines the deck's next songs up in the prefetch cache, when "Load upcoming songs ahead" is on. */
export async function prefetchAudition(songIds: string[]): Promise<void> {
    if (!isLookaheadEnabled() || db == undefined) {
        prefetcher.want([]);
        return;
    }
    const songs: Song[] = [];
    for (const songId of songIds) {
        const song = await DbQueries.getSong(db, songId);
        if (song != undefined) {
            songs.push(song);
        }
    }
    prefetcher.want(songs);
}

async function startNewSong(songId: string, recentlyPlayedSong?: RecentlyPlayedSong) {
    const localSessionData = await DbQueries.getActiveLocalSessionData(db);
    const songWithArtist = await DbQueries.fetchSongDetails(db, songId);
    const song = songWithArtist.song;
    let recentlyPlayedSongFound = false;

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

    await loadTrack(songWithArtist);
    await TrackPlayer.play();

    const timeSongStarted = new Date(Date.now());

    // Update state
    useActiveSong.getState().setSongId(songId);
    useAuditionFinished.getState().setPlaylistId(undefined);

    if (recentlyPlayedSongFound) {
        const timestampSeconds = recentlyPlayedSong?.timestampSeconds ?? 0;
        await TrackPlayer.seekTo(timestampSeconds);
        // markCurrent, not the progress writer: every marker was just cleared above, and only a genuine
        // start/resume may set one. The progress writer deliberately cannot, so a late tick from the song that
        // just finished can't resurrect it as "current" and get itself played twice.
        await DbQueries.markRecentlyPlayedSongCurrent(db, recentlyPlayedSong?.recentlyPlayedSongId!, timestampSeconds);
    } else {
        await DbQueries.addRecentlyPlayedSong(db, {
            songId: songId,
            recentlyPlayedSongId: generateId(),
            timestampSeconds: 0,
            lastPlayed: timeSongStarted
        });
    }

    // Read BEFORE this start stamps lastPlayed below (a new UserSong row is stamped too): if this is the song that
    // completes the mix, the mix has to count as unfinished as it starts, so that it can finish when it ends.
    // A RESUME keeps what was recorded when the song first started: it was stamped then, so re-reading now would
    // find the mix finished and never stop - the case after Android kills a paused player mid-way through the
    // last song.
    if (!recentlyPlayedSongFound) {
        await setAuditionInProgress(
            await DbQueries.getIncompleteAuditionPlaylistId(db, localSessionData.userId, await getSongFilters()));
    }

    const userSong = await DbQueries.recordPlayed(db, localSessionData.userId, songId, timeSongStarted);
    useSongStateRevision.getState().bump();

    // Reflect the new active song's saved like state on the notification buttons — and offer Keep only when
    // this one is actually an audition song.
    await refreshNotificationButtons((userSong.likeStatus as LikeStatus) ?? LikeStatus.Neutral, song.exploratory);

    // Last: the history and lastPlayed writes above are what the next picks are made from.
    scheduleLookaheadRefresh();
}

/**
 * Hands the song to the player, from downloads, the prefetch cache or a stream, without starting it. Writes nothing:
 * stamping it as played is the caller's business (startNewSong does at once; audition mode only once it is heard).
 */
async function loadTrack(songWithArtist: SongDetails) {
    const song = songWithArtist.song;
    const songId = song.songId;
    let songUri: string;

    // Before the cache is asked for the file: from here on the prefetcher keeps it, and drops the song before it.
    prefetcher.markPlaying(songId);

    const localSongUri = Downloader.generateLocalSongUri(song);
    const downloaded = await Downloader.fileExists(localSongUri);
    const prefetched = downloaded ? undefined : await prefetcher.filesFor(song);
    // Remembered, not just branched on: only a STREAMED track can fail for a network reason, so this is what
    // stops a corrupt local file from being waited out as though the connection were at fault.
    activeSourceIsLocal = downloaded || prefetched != undefined;

    if (downloaded) {
        songUri = localSongUri;
    } else if (prefetched != undefined) {
        songUri = prefetched.audioUri;
    } else {
        songUri = await generateUrl(song, false);
    }

    activeStreamUrl = activeSourceIsLocal ? undefined : songUri;
    console.info(`[player] starting ${songId} from ${downloaded ? "downloads" : prefetched ? "the prefetch cache" : "a stream"}`);

    // Album art for the lock-screen / media-notification. Without an `artwork` on the track, Media3 has
    // nothing to render, which is why the notification showed no icon. Prefer the already-downloaded local
    // file (same resolution the Song Info screen uses), fall back to the server URL when it isn't on disk.
    let artworkUri: string;
    const localArtUri = Downloader.generateLocalAlbumArtUri(song);
    if (await Downloader.fileExists(localArtUri)) {
        artworkUri = localArtUri;
    } else if (prefetched?.artUri != undefined) {
        artworkUri = prefetched.artUri;
    } else {
        artworkUri = await Downloader.generateServerAlbumArtUrl(song);
    }

    // A different track supersedes any recovery in flight for the previous one - including a retry timer that
    // has not fired yet, which would otherwise restart the song the player has just moved off.
    clearStall();

    await clearSong();
    await TrackPlayer.add([{
        id: songId,
        url: songUri,
        title: song.name,
        artist: songWithArtist.artists.length > 0 ? songWithArtist.artists.map(x => x.name).join(", ") : "Unknown Artist",
        artwork: artworkUri,
    }]);
}

/** skip()'s shuffle pick at the moment of the skip: the same rule the lookahead picks ahead with, nothing played yet. */
async function getRandomSongId(): Promise<string | undefined> {
    return pickShuffleSong([]);
}

function isLookaheadEnabled(): boolean {
    return prefetcher.supported && usePrefetchSetting.getState().enabled;
}

/** Turns "Load upcoming songs ahead" on or off. Off throws away what is lined up and everything fetched for it. */
export async function setPrefetchUpcoming(enabled: boolean): Promise<void> {
    await savePrefetchSetting(enabled);
    scheduleLookaheadRefresh();
}

/**
 * Recomputes the lookahead and hands it to the prefetcher, off the transport lock: picking reads the song pool,
 * which is too slow to hold a skip up for. Calls while one runs fold into one more run after it, and a run that
 * a skip or a dislike overtook goes round again, so the last word always comes from the latest state.
 */
function scheduleLookaheadRefresh() {
    if (lookaheadRefreshRunning) {
        lookaheadRefreshAgain = true;
        return;
    }

    lookaheadRefreshRunning = true;
    void (async () => {
        try {
            do {
                lookaheadRefreshAgain = false;
                await refreshLookaheadOnce();
            } while (lookaheadRefreshAgain);
        } catch (e) {
            console.warn("[lookahead] refresh failed", e);
        } finally {
            lookaheadRefreshRunning = false;
        }
    })();
}

async function refreshLookaheadOnce() {
    // The deck lines its own songs up (prefetchAudition); the shuffle's picks would only push them out.
    if (auditionController != undefined) {
        return;
    }

    if (!isLookaheadEnabled() || db == undefined) {
        lookahead.reset();
        prefetcher.want([]);
        return;
    }

    const upcoming = await lookahead.refresh();

    if (upcoming == undefined) {
        lookaheadRefreshAgain = true;
        return;
    }

    const songs: Song[] = [];
    for (const songId of upcoming) {
        const song = await DbQueries.getSong(db, songId);
        if (song != undefined) {
            songs.push(song);
        }
    }

    console.info(`[lookahead] next: ${upcoming.length ? upcoming.join(", ") : "nothing"}`);
    prefetcher.want(songs);
}

/**
 * The songs the shuffle picks from: the scope's songs when any filter is set, ordered by last_played ASC, or
 * undefined for "the whole library". No scope set used to return nothing, which halted playback after a single
 * song whenever the filters happened to be empty, the dead end reached from any list screen.
 */
async function getShufflePool(): Promise<ShuffleCandidate[] | undefined> {
    const songFilters = await getSongFilters();
    return songFilters.hasAnyFilter() ? await DbQueries.getFilteredSong(db, songFilters) : undefined;
}

/**
 * The shuffle's next song once `played` have played. skip() calls it with nothing played; the lookahead calls it
 * ahead of the skip with the songs lined up before this one, so both modes pick by one rule.
 */
async function pickShuffleSong(played: readonly string[]): Promise<string | undefined> {
    const pool = await getShufflePool();

    if (pool != undefined) {
        // The song that just finished is at the END of the pool, so the selection window off the front cannot
        // reach it; asIfJustPlayed moves the lined-up songs back the same way. See shuffle.ts, where both are tested.
        return selectNextSong(asIfJustPlayed(pool, played));
    }

    // The whole library has no window to keep the lined-up songs out of, so just don't line one up twice.
    let songId: string | undefined;
    for (let attempt = 0; attempt < LIBRARY_PICK_ATTEMPTS; attempt++) {
        songId = await DbQueries.getRandomSongId(db);
        if (songId == undefined || !played.includes(songId)) {
            break;
        }
    }

    return songId;
}

/** Whether a song picked ahead may still be the shuffle's next song: still in the scope's pool, or the library. */
async function isShuffleEligible(songId: string): Promise<boolean> {
    const pool = await getShufflePool();

    if (pool != undefined) {
        return pool.some(x => x.songId === songId);
    }

    return (await DbQueries.getSong(db, songId)) != undefined;
}
