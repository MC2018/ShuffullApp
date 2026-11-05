// Waiting on the player while the app may leave the screen (ShuffullApp#179).
//
// A JS timer can sit stalled while the app is in the background and fire only when it comes back, minutes later.
// That is how audition mode's jump to a song's start point, meant for the song's first second, once landed minutes
// into a song that had been playing from 0:00 in the background the whole time. Native events (the player's, the
// app state's) still arrive in the background, so a wait that wakes on the app leaving never depends on a timer.

/** The slice of React Native's AppState used here, so the logic runs in a unit test. */
export interface AppStateSource {
    currentState: string | null | undefined;
    addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

/** Off screen: home, lock screen, another app. iOS's "inactive" (Control Center, a call banner) is not leaving. */
export function isBackground(state: string | null | undefined): boolean {
    return state === "background";
}

export interface ForegroundWatch {
    /** The app has been in the background at some point since the watch began (or was there when it began). */
    readonly hasLeftForeground: boolean;
    /** Sleeps `ms`, or less: it wakes the moment the app leaves, however stalled the timer is. */
    sleep(ms: number): Promise<void>;
    dispose(): void;
}

export function watchForeground(appState: AppStateSource, setTimer: (fn: () => void, ms: number) => unknown = setTimeout): ForegroundWatch {
    let hasLeft = isBackground(appState.currentState);
    let wake: (() => void) | undefined;
    const subscription = appState.addEventListener("change", state => {
        if (isBackground(state)) {
            hasLeft = true;
            wake?.();
        }
    });
    return {
        get hasLeftForeground() {
            return hasLeft;
        },
        sleep(ms: number) {
            if (hasLeft) {
                return Promise.resolve();
            }
            return new Promise<void>(resolve => {
                wake = resolve;
                setTimer(resolve, ms);
            });
        },
        dispose() {
            wake = undefined;
            subscription.remove();
        },
    };
}

/**
 * The loaded track's length in seconds once the player knows it. 0 if it doesn't within `timeoutMs`, or if the app
 * leaves the foreground first: the caller then plays from the top rather than wait on a timer that may not fire.
 */
export async function waitForDuration(
    getDuration: () => Promise<number>,
    watch: ForegroundWatch,
    timeoutMs: number,
    now: () => number = Date.now,
    pollMs = 100,
): Promise<number> {
    const deadline = now() + timeoutMs;
    while (!watch.hasLeftForeground) {
        const duration = await getDuration();
        if (duration > 0) {
            // Left while the player was answering: still off screen, so still from the top.
            return watch.hasLeftForeground ? 0 : duration;
        }
        if (now() >= deadline) {
            return 0;
        }
        await watch.sleep(pollMs);
    }
    return 0;
}
