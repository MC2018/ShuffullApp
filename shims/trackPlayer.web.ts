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
 * OS transport keys (play/pause, next, previous) are wired up through the Media Session API — see
 * `setupMediaSession` below. Still not implemented: background playback once the window is closed, and the
 * media notification's custom like/dislike buttons, which have no Media Session equivalent — `updateOptions`
 * is accepted and ignored for that reason.
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
let isSetup = false;

type Listener = (payload: any) => void;
const listeners = new Map<Event, Set<Listener>>();

function emit(event: Event, payload: any = {}) {
    listeners.get(event)?.forEach((l) => l(payload));
}

function setState(next: State) {
    state = next;
    syncPlaybackState(next);
    emit(Event.PlaybackState, { state: next });
}

// ── Media Session: the OS transport keys ──────────────────────────────────────────────────────
/**
 * Wires the keyboard's media keys (Fn+F6/F7/F8 on this keyboard) and the desktop's media applet to the queue.
 *
 * Play/pause LOOKS like it needs none of this, because Chromium can pause and resume the underlying <audio>
 * element on its own. Next/previous have no such default: the browser has no idea what our queue is, so unless
 * the page registers these handlers it advertises CanGoNext/CanGoPrevious = false over MPRIS and the keypress
 * is discarded. That asymmetry is exactly why F7 worked while F6/F8 did nothing.
 *
 * The handlers only EMIT Remote* events. That is RNTP's own contract — Remote* means "the OS asked us to do
 * this", not "this happened" — so mediaManager's existing listeners do the work and none of the queue logic
 * becomes web-specific. They must never call back into the TrackPlayer methods below: seekTo emitting
 * RemoteSeek is precisely the loop that recursed until the stack blew.
 *
 * Typed structurally rather than against lib.dom's MediaSession so this compiles under the React Native TS
 * config, which does not necessarily ship those DOM definitions.
 */
type MediaSessionLike = {
    metadata: unknown;
    playbackState: "none" | "paused" | "playing";
    setActionHandler: (action: string, handler: ((details?: any) => void) | null) => void;
    setPositionState?: (state: { duration: number; position: number; playbackRate?: number }) => void;
};

function media(): MediaSessionLike | undefined {
    return (globalThis as any)?.navigator?.mediaSession;
}

/**
 * Keeps the OS's idea of play/pause honest. This matters more than it looks: mediaManager.play() treats a
 * RemotePlay that arrives while ALREADY playing as a skip, so a stale "paused" here would turn the play key
 * into a next-track key.
 */
function syncPlaybackState(next: State) {
    const ms = media();
    if (!ms) {
        return;
    }

    ms.playbackState =
        next === State.Playing || next === State.Buffering || next === State.Loading ? "playing"
        : next === State.None || next === State.Error ? "none"
        : "paused";
}

let mediaSessionReady = false;

function setupMediaSession() {
    const ms = media();
    if (!ms || mediaSessionReady) {
        return;
    }

    // Each action is bound defensively: an action a given browser doesn't know throws on assignment, and one
    // unsupported key must not take the rest of the transport controls down with it.
    const bind = (action: string, handler: (details?: any) => void) => {
        try {
            ms.setActionHandler(action, handler);
        } catch {
            // Unsupported action — skip it.
        }
    };

    bind("play", () => emit(Event.RemotePlay));
    bind("pause", () => emit(Event.RemotePause));
    bind("nexttrack", () => emit(Event.RemoteNext));
    bind("previoustrack", () => emit(Event.RemotePrevious));
    bind("seekto", (details) => {
        if (typeof details?.seekTime === "number") {
            emit(Event.RemoteSeek, { position: details.seekTime });
        }
    });

    mediaSessionReady = true;
}

/** Title/artist/art for the desktop media applet, which otherwise just shows "Electron". */
function publishMetadata(track: Track | undefined) {
    const ms = media();
    const Metadata = (globalThis as any)?.MediaMetadata;
    if (!ms || !Metadata || !track) {
        return;
    }

    try {
        ms.metadata = new Metadata({
            title: track.title ?? "",
            artist: track.artist ?? "",
            artwork: track.artwork ? [{ src: String(track.artwork) }] : [],
        });
    } catch {
        // Purely cosmetic: never let an unreachable album-art URL interfere with playback.
    }
}

/**
 * Publishes duration/position so the applet can draw a scrubber. Only needed on load and after a seek —
 * Chromium extrapolates position from the last report and the playback rate, so there is no need to feed it
 * every timeupdate.
 */
function publishPosition() {
    const ms = media();
    if (!ms?.setPositionState || !audio) {
        return;
    }

    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
        return;
    }

    try {
        ms.setPositionState({
            duration,
            position: Math.min(audio.currentTime || 0, duration),
            playbackRate: audio.playbackRate || 1,
        });
    } catch {
        // Throws if position momentarily exceeds duration mid-load; harmless.
    }
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
        // Duration is unknown until metadata lands, so the applet's scrubber can only be published here.
        audio.addEventListener("loadedmetadata", publishPosition);
        audio.addEventListener("seeked", publishPosition);
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
    publishMetadata(track);
    emit(Event.PlaybackActiveTrackChanged, { index, track });
    if (autoplay) await a.play().catch(() => setState(State.Error));
}

const TrackPlayer = {
    /**
     * State.None, not State.Ready. In RNTP, Ready means "a track is loaded and ready to play" — an idle player
     * with an empty queue reports None. Reporting Ready here made mediaManager's play() take its RESUME branch
     * and call play() on an empty queue, so the playlist Play button did nothing on a fresh launch.
     */
    async setupPlayer() { el(); setupMediaSession(); isSetup = true; setState(State.None); },
    /**
     * Accepted and ignored. Transport capabilities are fixed on web — setupMediaSession registers the full
     * set once — and the only other thing these options carry is the notification's custom like/dislike
     * buttons, which Media Session has no equivalent for.
     */
    async updateOptions(_options?: unknown) { },

    /**
     * On native this hands RNTP a factory whose returned function runs in a separate headless service. There
     * is no such process on web, so the service function is simply invoked here — the listeners it registers
     * are what advance the queue when a track ends. Leaving this a no-op (as it first was) meant nothing was
     * ever subscribed to Event.PlaybackState, so playback stopped silently at the end of every song.
     */
    registerPlaybackService(factory: () => any) {
        Promise.resolve(factory())
            .then((service) => (typeof service === "function" ? service() : undefined))
            .catch((e) => console.error("Playback service failed to start:", e));
    },

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
            if (i < activeIndex) {
                activeIndex--;
            } else if (i === activeIndex) {
                // Removing the ACTIVE track has to clear the cursor, not just the entry. mediaManager plays
                // each song by emptying the queue and adding one track, so leaving activeIndex pointing at the
                // removed slot made the following `add` skip its load() — the element kept the previous song's
                // src and every track after the first silently replayed (or did nothing).
                activeIndex = -1;
            }
        }

        if (activeIndex === -1) {
            if (audio) {
                audio.pause();
                audio.removeAttribute("src");
                audio.load();
            }
            // Back to idle: nothing is loaded, so anything asking "can I resume?" must be told no.
            setState(State.None);
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
    /**
     * Does NOT emit Event.RemoteSeek. In RNTP the Remote* events are INPUT - "the OS/lock-screen asked us to
     * do this" - not notifications that it happened. mediaManager listens for RemoteSeek and responds by
     * calling seekTo, so emitting it here made seekTo call itself forever: a stack overflow every time a song
     * resumed at a saved position. (Latent until registerPlaybackService actually began registering listeners;
     * before that the emit went nowhere.)
     */
    async seekTo(position: number) { el().currentTime = position; },

    async getProgress() {
        const a = el();
        return { position: a.currentTime || 0, duration: Number.isFinite(a.duration) ? a.duration : 0, buffered: 0 };
    },
    async getQueue() { return queue; },
    /**
     * Throws before setupPlayer(), matching RNTP. mediaManager's initTrackPlayer() probes with this inside a
     * try/catch and only does its one-time setup (registering the playback service, setupPlayer) in the catch
     * — so returning undefined here quietly skipped ALL of that on web.
     */
    async getActiveTrack() {
        if (!isSetup) {
            throw new Error("The player is not initialized. Call setupPlayer first.");
        }
        return queue[activeIndex];
    },
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
