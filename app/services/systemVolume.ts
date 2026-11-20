import { useEffect } from "react";
import { create } from "zustand";
import { desktopShell, DesktopVolumeState } from "./desktopShell";
import { clampVolume } from "../tools/volume";

/**
 * The volume of the speaker Shuffull plays on (ShuffullApp#217), shared by every slider on screen.
 *
 * Desktop only: the Electron shell reads and sets it through `pactl` (desktop/volume.js). Everywhere else the
 * bridge is absent, `available` stays false and the sliders render nothing.
 *
 * Echo suppression. A drag sends many levels a second, and main reports each one back as it lands, a little
 * behind. Applying those reports mid-drag would yank the thumb backwards, so reports are ignored while the user is
 * interacting and for a moment after; then one fresh read settles on the real level.
 */

const SETTLE_MS = 400;
// Unmuting a speaker that sits at 0 would still be silent, so it comes back at this level.
const UNMUTE_FROM_ZERO_LEVEL = 30;

interface SystemVolumeStore {
    state: DesktopVolumeState;
    /** Reports from main before this time are ignored (see the header). */
    holdUntil: number;
    dragging: boolean;
}

export const useSystemVolumeStore = create<SystemVolumeStore>(() => ({
    state: { available: false },
    holdUntil: 0,
    dragging: false,
}));

let subscribers = 0;
let unsubscribe: (() => void) | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function accept(state: DesktopVolumeState) {
    const { holdUntil, dragging } = useSystemVolumeStore.getState();
    if (dragging || Date.now() < holdUntil) {return;}
    useSystemVolumeStore.setState({ state });
}

function refresh() {
    void desktopShell()?.volume?.get().then(accept, () => {});
}

/** After an interaction, wait out the echoes, then take one fresh read. */
function scheduleSettle() {
    useSystemVolumeStore.setState({ holdUntil: Date.now() + SETTLE_MS });
    if (settleTimer) {clearTimeout(settleTimer);}
    settleTimer = setTimeout(refresh, SETTLE_MS + 20);
}

function start() {
    const bridge = desktopShell()?.volume;
    if (!bridge) {return;}
    unsubscribe = bridge.onChange(accept);
    refresh();
}

function stop() {
    unsubscribe?.();
    unsubscribe = null;
}

/** Follows the shell's level until the returned function is called. One bridge subscription however many callers. */
export function subscribeSystemVolume(): () => void {
    if (subscribers++ === 0) {start();}
    let done = false;
    return () => {
        if (done) {return;}
        done = true;
        if (--subscribers === 0) {stop();}
    };
}

/** The level, followed for as long as the caller is mounted. */
export function useSystemVolume(): DesktopVolumeState {
    useEffect(() => subscribeSystemVolume(), []);
    return useSystemVolumeStore((s) => s.state);
}

function optimistic(change: { volume?: number; muted?: boolean }) {
    const { state } = useSystemVolumeStore.getState();
    if (!state.available) {return;}
    useSystemVolumeStore.setState({ state: { ...state, ...change } });
}

/** Sets the level. Raising it above 0 also unmutes, as the system's own slider does. */
export function setSystemVolume(level: number) {
    const { state } = useSystemVolumeStore.getState();
    if (!state.available) {return;}
    const volume = clampVolume(level);
    const change = state.muted && volume > 0 ? { volume, muted: false } : { volume };
    optimistic(change);
    void desktopShell()?.volume?.set(change);
    scheduleSettle();
}

export function toggleSystemMute() {
    const { state } = useSystemVolumeStore.getState();
    if (!state.available) {return;}
    let change: { volume?: number; muted: boolean };
    if (state.volume === 0) {
        change = { muted: false, volume: UNMUTE_FROM_ZERO_LEVEL };
    } else if (state.muted) {
        change = { muted: false };
    } else {
        change = { muted: true };
    }
    optimistic(change);
    void desktopShell()?.volume?.set(change);
    scheduleSettle();
}

/** While true, reports from main are ignored so the thumb stays under the pointer. */
export function setVolumeDragging(dragging: boolean) {
    useSystemVolumeStore.setState({ dragging });
    if (!dragging) {scheduleSettle();}
}
