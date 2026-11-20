import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopVolumeState } from "@/app/services/desktopShell";

// The renderer's shared volume level (app/services/systemVolume.ts) against a fake desktop bridge.

type Listener = (state: DesktopVolumeState) => void;

function installBridge(initial: DesktopVolumeState) {
    const listeners: Listener[] = [];
    const bridge = {
        get: vi.fn(async () => initial),
        set: vi.fn(async () => initial),
        onChange: vi.fn((cb: Listener) => {
            listeners.push(cb);
            return () => listeners.splice(listeners.indexOf(cb), 1);
        }),
    };
    (globalThis as unknown as { window: unknown }).window = { shuffull: { volume: bridge } };
    return { bridge, emit: (s: DesktopVolumeState) => listeners.forEach((l) => l(s)) };
}

const at = (volume: number, muted = false): DesktopVolumeState => ({ available: true, volume, muted, device: "Fosi Audio BT30D" });

async function load(initial: DesktopVolumeState) {
    vi.resetModules();
    const fake = installBridge(initial);
    const mod = await import("@/app/services/systemVolume");
    mod.useSystemVolumeStore.setState({ state: initial, holdUntil: 0, dragging: false });
    return { ...fake, ...mod, level: () => mod.useSystemVolumeStore.getState().state };
}

describe("systemVolume", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as unknown as { window?: unknown }).window;
    });

    it("sets the level at once and sends it to the shell", async () => {
        const v = await load(at(40));
        v.setSystemVolume(62.7);
        expect(v.level()).toEqual(at(63));
        expect(v.bridge.set).toHaveBeenCalledWith({ volume: 63 });
    });

    it("raising a muted speaker above 0 unmutes it", async () => {
        const v = await load(at(40, true));
        v.setSystemVolume(50);
        expect(v.bridge.set).toHaveBeenCalledWith({ volume: 50, muted: false });
        expect(v.level()).toEqual(at(50, false));
    });

    it("mute toggles, and unmuting at 0 brings it back to an audible level", async () => {
        const v = await load(at(40));
        v.toggleSystemMute();
        expect(v.bridge.set).toHaveBeenLastCalledWith({ muted: true });
        v.toggleSystemMute();
        expect(v.bridge.set).toHaveBeenLastCalledWith({ muted: false });

        const z = await load(at(0));
        z.toggleSystemMute();
        expect(z.bridge.set).toHaveBeenLastCalledWith({ muted: false, volume: 30 });
    });

    it("ignores the shell's reports during a drag and just after, then settles on a fresh read", async () => {
        const v = await load(at(40));
        const unsubscribe = v.subscribeSystemVolume();
        await vi.advanceTimersByTimeAsync(0); // the initial read

        v.setVolumeDragging(true);
        v.setSystemVolume(70);
        v.setSystemVolume(80);
        // An echo of the first level lands mid-drag: the thumb must not jump back.
        v.emit(at(70));
        expect(v.level()).toEqual(at(80));

        v.setSystemVolume(90);
        v.setVolumeDragging(false);
        v.bridge.get.mockResolvedValue(at(90));
        await vi.advanceTimersByTimeAsync(500);
        expect(v.bridge.get).toHaveBeenCalled();
        expect(v.level()).toEqual(at(90));

        // Once settled, a change made elsewhere (the Sound settings, the volume keys) shows straight away.
        v.emit(at(25));
        expect(v.level()).toEqual(at(25));
        unsubscribe();
        expect(v.bridge.onChange).toHaveBeenCalledTimes(1);
    });

    it("shares one bridge subscription between callers, and drops it when the last one leaves", async () => {
        const v = await load(at(40));
        const a = v.subscribeSystemVolume();
        const b = v.subscribeSystemVolume();
        expect(v.bridge.onChange).toHaveBeenCalledTimes(1);
        a();
        a(); // a second call must not release b's share
        v.emit(at(55));
        expect(v.level()).toEqual(at(55));
        b();
        v.emit(at(10));
        expect(v.level()).toEqual(at(55));
    });

    it("does nothing while the level is unavailable (no shell, or nothing to control)", async () => {
        const v = await load({ available: false });
        v.setSystemVolume(50);
        v.toggleSystemMute();
        expect(v.bridge.set).not.toHaveBeenCalled();
        expect(v.level()).toEqual({ available: false });
    });
});
