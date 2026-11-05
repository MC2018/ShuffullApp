import { describe, it, expect } from "vitest";
import { AppStateSource, isBackground, waitForDuration, watchForeground } from "@/app/tools/foregroundWatch";

// Audition mode waits on the player for a song's length before jumping to its start point (ShuffullApp#179). A JS
// timer can stall while the app is in the background and fire only on the way back in, so the wait has to end the
// moment the app leaves, on the app-state event alone.

class FakeAppState implements AppStateSource {
    private listeners = new Set<(state: string) => void>();
    constructor(public currentState: string) { }
    addEventListener(_type: "change", listener: (state: string) => void) {
        this.listeners.add(listener);
        return { remove: () => this.listeners.delete(listener) };
    }
    change(state: string) {
        this.currentState = state;
        for (const listener of this.listeners) {
            listener(state);
        }
    }
    get listening() {
        return this.listeners.size;
    }
}

/** A timer that never fires: the background stall, at its worst. */
const stalledTimer = () => undefined;
/** A timer that fires at once. */
const instantTimer = (fn: () => void) => { fn(); };

describe("isBackground", () => {
    it("treats only background as off screen", () => {
        expect(isBackground("background")).toBe(true);
        expect(isBackground("active")).toBe(false);
        expect(isBackground("inactive")).toBe(false); // iOS Control Center, call banners
        expect(isBackground(undefined)).toBe(false);
        expect(isBackground("unknown")).toBe(false);
    });
});

describe("watchForeground", () => {
    it("wakes a stalled sleep the moment the app leaves, and stays left after it comes back", async () => {
        const appState = new FakeAppState("active");
        const watch = watchForeground(appState, stalledTimer);
        const slept = watch.sleep(100);
        appState.change("background");
        await slept; // would hang forever without the wake
        appState.change("active");
        expect(watch.hasLeftForeground).toBe(true);
        watch.dispose();
        expect(appState.listening).toBe(0);
    });

    it("counts an app already in the background as left", async () => {
        const watch = watchForeground(new FakeAppState("background"), stalledTimer);
        expect(watch.hasLeftForeground).toBe(true);
        await watch.sleep(100); // returns at once
    });
});

describe("waitForDuration", () => {
    it("returns the length once the player knows it", async () => {
        const appState = new FakeAppState("active");
        const durations = [0, 0, 212];
        const watch = watchForeground(appState, instantTimer);
        expect(await waitForDuration(async () => durations.shift() ?? 212, watch, 1_500)).toBe(212);
    });

    it("gives up after the timeout", async () => {
        let ms = 0;
        const watch = watchForeground(new FakeAppState("active"), (fn, delay) => { ms += delay; fn(); });
        expect(await waitForDuration(async () => 0, watch, 1_500, () => ms)).toBe(0);
        expect(ms).toBeGreaterThanOrEqual(1_500);
    });

    it("gives up at once when the app leaves, though the timer is stalled", async () => {
        const appState = new FakeAppState("active");
        const watch = watchForeground(appState, stalledTimer);
        const waiting = waitForDuration(async () => 0, watch, 1_500);
        await Promise.resolve();
        appState.change("background");
        expect(await waiting).toBe(0);
    });

    it("returns 0 when the app left while the player was answering, so the song still starts from the top", async () => {
        const appState = new FakeAppState("active");
        const watch = watchForeground(appState, stalledTimer);
        expect(await waitForDuration(async () => {
            appState.change("background");
            return 212;
        }, watch, 1_500)).toBe(0);
    });
});
