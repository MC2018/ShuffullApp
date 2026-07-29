import { useEffect, useState } from "react";

/**
 * Web/desktop stand-in for `react-native-track-player`.
 *
 * RNTP is native-only — it calls `TurboModuleRegistry.getEnforcing` at module scope, which throws while the
 * bundle is evaluating and takes the whole app down before React mounts. Metro aliases this module in its
 * place for the web platform (see metro.config.js), so `mediaManager.ts` and the transport components run
 * unmodified: we replace the PLAYER, not the manager built on top of it.
 *
 * Backed by a single HTMLAudioElement, which is genuinely how playback should work here — Electron ships
 * Chromium, so codec support matches the browser. It implements only the surface this app actually uses;
 * anything else is deliberately absent so a missing feature fails loudly rather than silently no-ops.
 *
 * Not implemented (needs the Media Session API to do properly): OS/lock-screen transport controls, and
 * background playback when the window is closed. `updateOptions` is accepted and ignored for that reason.
 */

// ── enums, matching RNTP's shape ──────────────────────────────────────────────────────────────
export enum State {
    None = "none",
    Ready = "ready",
    Playing = "playing",
    Paused = "paused",
    Stopped = "stopped",
    Buffering = "buffering",
    Loading = "loading",
    Ended = "ended",
    Error = "error",
}

export enum Event {
    PlaybackState = "playback-state",
    PlaybackActiveTrackChanged = "playback-active-track-changed",
    PlaybackQueueEnded = "playback-queue-ended",
    RemotePlay = "remote-play",
    RemotePause = "remote-pause",
    RemoteNext = "remote-next",
    RemotePrevious = "remote-previous",
    RemoteSeek = "remote-seek",
    RemoteCustomAction = "remote-custom-action",
}

export enum Capability {
    Play = "play",
    Pause = "pause",
    SeekTo = "seek-to",
    Skip = "skip",
    SkipToNext = "skip-to-next",
    SkipToPrevious = "skip-to-previous",
}

export type PlaybackState = { state: State };
export type RemoteSeekEvent = { position: number };
export type Track = { url: string; title?: string; artist?: string; artwork?: string; [k: string]: unknown };

// ── player state ──────────────────────────────────────────────────────────────────────────────
let audio: HTMLAudioElement | null = null;
let queue: Track[] = [];
let activeIndex = -1;
let state: State = State.None;

type Listener = (payload: any) => void;
const listeners = new Map<Event, Set<Listener>>();

function emit(event: Event, payload: any = {}) {
    listeners.get(event)?.forEach((l) => l(payload));
}

function setState(next: State) {
    state = next;
    emit(Event.PlaybackState, { state: next });
}

function el(): HTMLAudioElement {
    if (!audio) {
        audio = new Audio();
        audio.addEventListener("playing", () => setState(State.Playing));
        audio.addEventListener("pause", () => setState(State.Paused));
        audio.addEventListener("waiting", () => setState(State.Buffering));
        audio.addEventListener("canplay", () => { if (state === State.Buffering) setState(State.Ready); });
        audio.addEventListener("ended", () => {
            setState(State.Ended);
            // The manager listens for this to advance the queue, exactly as it does natively.
            emit(Event.PlaybackQueueEnded, { track: activeIndex, position: audio?.currentTime ?? 0 });
        });
        audio.addEventListener("error", () => setState(State.Error));
    }
    return audio;
}

async function load(index: number, autoplay: boolean) {
    const track = queue[index];
    if (!track) return;
    activeIndex = index;
    const a = el();
    a.src = track.url;
    a.load();
    emit(Event.PlaybackActiveTrackChanged, { index, track });
    if (autoplay) await a.play().catch(() => setState(State.Error));
}

const TrackPlayer = {
    async setupPlayer() { el(); setState(State.Ready); },
    /** Accepted and ignored — OS transport controls would need the Media Session API. */
    async updateOptions(_options?: unknown) { },
    /** Native-only concept; there is no background service on web. */
    registerPlaybackService(_factory: () => any) { },

    async add(tracks: Track | Track[], insertBeforeIndex?: number) {
        const items = Array.isArray(tracks) ? tracks : [tracks];
        if (insertBeforeIndex == null || insertBeforeIndex < 0) queue.push(...items);
        else queue.splice(insertBeforeIndex, 0, ...items);
        if (activeIndex === -1 && queue.length > 0) await load(0, false);
    },

    async remove(indexes: number | number[]) {
        const list = (Array.isArray(indexes) ? indexes : [indexes]).sort((a, b) => b - a);
        for (const i of list) {
            queue.splice(i, 1);
            if (i < activeIndex) activeIndex--;
        }
    },

    async reset() {
        queue = [];
        activeIndex = -1;
        if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
        setState(State.None);
    },

    async play() {
        if (activeIndex === -1 && queue.length > 0) return load(0, true);
        await el().play().catch(() => setState(State.Error));
    },
    async pause() { el().pause(); },
    async seekTo(position: number) { el().currentTime = position; emit(Event.RemoteSeek, { position }); },

    async getProgress() {
        const a = el();
        return { position: a.currentTime || 0, duration: Number.isFinite(a.duration) ? a.duration : 0, buffered: 0 };
    },
    async getQueue() { return queue; },
    async getActiveTrack() { return queue[activeIndex]; },
    async getActiveTrackIndex() { return activeIndex === -1 ? undefined : activeIndex; },
    async getPlaybackState(): Promise<PlaybackState> { return { state }; },

    addEventListener(event: Event, listener: Listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
        // Braces matter: Set.delete returns a boolean, and handing that back would make this an invalid
        // useEffect cleanup (React expects void or a destructor).
        return { remove: () => { listeners.get(event)?.delete(listener); } };
    },
};

export async function getPlaybackState(): Promise<PlaybackState> {
    return { state };
}

// ── hooks ─────────────────────────────────────────────────────────────────────────────────────

/** Polls, matching RNTP's own hook semantics closely enough for the transport UI. */
export function useProgress(updateInterval = 500) {
    const [progress, setProgress] = useState({ position: 0, duration: 0, buffered: 0 });
    useEffect(() => {
        const id = setInterval(async () => setProgress(await TrackPlayer.getProgress()), updateInterval);
        return () => clearInterval(id);
    }, [updateInterval]);
    return progress;
}

export function usePlaybackState(): PlaybackState {
    const [current, setCurrent] = useState<PlaybackState>({ state });
    useEffect(() => {
        const sub = TrackPlayer.addEventListener(Event.PlaybackState, (p) => setCurrent({ state: p.state }));
        return () => sub.remove();
    }, []);
    return current;
}

export function useActiveTrack(): Track | undefined {
    const [track, setTrack] = useState<Track | undefined>(queue[activeIndex]);
    useEffect(() => {
        const sub = TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, (p) => setTrack(p.track));
        return () => sub.remove();
    }, []);
    return track;
}

export default TrackPlayer;
