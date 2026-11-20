import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { clampVolume, volumeAfterKey, volumeAfterWheel, volumeGlyph } from "@/app/tools/volume";

// desktop/volume.js is the Electron main process's CommonJS module; it doesn't import Electron, so it runs here.
const require = createRequire(import.meta.url);
const { VolumeController, watchVolume, findOwnSink, findSetpriv, subscribeCommand, volumePercent } = require("../desktop/volume.js");

const NORM = 65536;
const level = (percent: number) => ({ "front-left": { value: Math.round((percent / 100) * NORM) }, "front-right": { value: Math.round((percent / 100) * NORM) } });

interface Sink {
    index: number;
    name: string;
    description: string;
    mute: boolean | string;
    volume: Record<string, { value: number }>;
}

const onboard = (): Sink => ({ index: 57, name: "alsa_output.onboard", description: "Onboard Audio", mute: false, volume: level(40) });
const amp = (): Sink => ({ index: 10637, name: "bluez_output.fosi", description: "Fosi Audio BT30D", mute: false, volume: level(70) });
const stream = (sink: number, corked = false, app = "Shuffull") => ({ sink, corked, properties: { "application.name": app } });

/** A fake `pactl` over an in-memory set of sinks and streams. Records every set-* call. */
function fakePactl(initial: { sinks: Sink[]; inputs: unknown[]; defaultSink: string }) {
    const world = { ...initial };
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
        const cmd = args[0] === "-f" ? args.slice(2) : args;
        if (cmd[0] === "list" && cmd[1] === "sinks") {return JSON.stringify(world.sinks);}
        if (cmd[0] === "list" && cmd[1] === "sink-inputs") {return JSON.stringify(world.inputs);}
        if (cmd[0] === "get-default-sink") {return `${world.defaultSink}\n`;}
        calls.push(cmd);
        const sink = world.sinks.find((s) => String(s.index) === cmd[1]);
        if (cmd[0] === "set-sink-volume" && sink) {sink.volume = level(parseInt(cmd[2], 10));}
        if (cmd[0] === "set-sink-mute" && sink) {sink.mute = cmd[2] === "1";}
        return "";
    });
    return { world, calls, run };
}

describe("volumePercent", () => {
    it("averages the channels as a whole percent of 100%", () => {
        expect(volumePercent(level(50))).toBe(50);
        expect(volumePercent({ l: { value: NORM }, r: { value: NORM / 2 } })).toBe(75);
    });

    it("reads a missing or empty volume as 0", () => {
        expect(volumePercent(undefined)).toBe(0);
        expect(volumePercent({})).toBe(0);
    });
});

describe("findOwnSink", () => {
    it("finds Shuffull's stream and ignores other apps", () => {
        expect(findOwnSink([stream(57, false, "Firefox"), stream(10637)])).toBe(10637);
    });

    it("prefers a playing stream over a paused one", () => {
        expect(findOwnSink([stream(57, true), stream(10637, false)])).toBe(10637);
    });

    it("is null when Shuffull has no stream", () => {
        expect(findOwnSink([stream(57, false, "Firefox")])).toBeNull();
        expect(findOwnSink(undefined)).toBeNull();
    });
});

describe("VolumeController: which speaker", () => {
    it("controls the speaker Shuffull plays on, not the default output", async () => {
        const pactl = fakePactl({ sinks: [onboard(), amp()], inputs: [stream(10637)], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        expect(await c.read()).toEqual({ available: true, volume: 70, muted: false, device: "Fosi Audio BT30D" });
    });

    it("stays on that speaker after Shuffull's stream closes", async () => {
        const pactl = fakePactl({ sinks: [onboard(), amp()], inputs: [stream(10637)], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        await c.read();
        pactl.world.inputs = []; // paused a while: Chromium closed the stream
        expect((await c.read()).device).toBe("Fosi Audio BT30D");
    });

    it("falls back to the default output before Shuffull has played", async () => {
        const pactl = fakePactl({ sinks: [amp(), onboard()], inputs: [], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        expect((await c.read()).device).toBe("Onboard Audio");
    });

    it("forgets a speaker that went away and falls back to the default", async () => {
        const pactl = fakePactl({ sinks: [onboard(), amp()], inputs: [stream(10637)], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        await c.read();
        pactl.world.sinks = [onboard()]; // Bluetooth amp switched off
        pactl.world.inputs = [];
        expect((await c.read()).device).toBe("Onboard Audio");
        expect(c.lastSink).toBeNull();
    });

    it("shows a boosted level as 100%", async () => {
        const boosted = { ...onboard(), volume: level(150) };
        const pactl = fakePactl({ sinks: [boosted], inputs: [], defaultSink: boosted.name });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        expect((await c.read()).volume).toBe(100);
    });

    it("reads mute in both the boolean and the old yes/no form", async () => {
        const pactl = fakePactl({ sinks: [{ ...onboard(), mute: "yes" }], inputs: [], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        expect((await c.read()).muted).toBe(true);
    });
});

describe("VolumeController: unavailable", () => {
    it("is unavailable off Linux, without running pactl", async () => {
        const run = vi.fn();
        const c = new VolumeController({ run, platform: "win32" });
        expect(await c.read()).toEqual({ available: false });
        expect(await c.apply({ volume: 50 })).toEqual({ available: false });
        expect(run).not.toHaveBeenCalled();
    });

    it("is unavailable when pactl fails or there are no sinks", async () => {
        const failing = new VolumeController({ run: vi.fn().mockRejectedValue(new Error("ENOENT")), platform: "linux" });
        expect(await failing.read()).toEqual({ available: false });
        const empty = fakePactl({ sinks: [], inputs: [], defaultSink: "" });
        expect(await new VolumeController({ run: empty.run, platform: "linux" }).read()).toEqual({ available: false });
    });
});

describe("VolumeController: apply", () => {
    it("sets the level and mute on the target speaker and resolves the new state", async () => {
        const pactl = fakePactl({ sinks: [onboard(), amp()], inputs: [stream(10637)], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        const after = await c.apply({ volume: 33, muted: true });
        expect(pactl.calls).toEqual([
            ["set-sink-volume", "10637", "33%"],
            ["set-sink-mute", "10637", "1"],
        ]);
        expect(after).toMatchObject({ volume: 33, muted: true, device: "Fosi Audio BT30D" });
    });

    it("rounds and caps the level at 0-100, and never boosts past 100%", async () => {
        const pactl = fakePactl({ sinks: [onboard()], inputs: [], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        await c.apply({ volume: 180 });
        await c.apply({ volume: -5 });
        await c.apply({ volume: 41.6 });
        expect(pactl.calls.map((x) => x[2])).toEqual(["100%", "0%", "42%"]);
    });

    it("applies only the latest of a burst of levels (a drag)", async () => {
        const pactl = fakePactl({ sinks: [onboard()], inputs: [], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        const all = [c.apply({ volume: 10 }), c.apply({ volume: 20 }), c.apply({ volume: 30 }), c.apply({ volume: 40 })];
        await Promise.all(all);
        // The first starts at once; the three that arrive while it runs collapse into the last one.
        expect(pactl.calls.map((x) => x[2])).toEqual(["10%", "40%"]);
    });

    it("a burst shares one read afterwards, instead of a pactl read per call", async () => {
        const pactl = fakePactl({ sinks: [onboard()], inputs: [], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        const sinkReads = () => pactl.run.mock.calls.filter(([args]) => args.includes("sinks")).length;
        const states = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => c.apply({ volume: n * 10 })));
        // Two runs (10%, then 60%) each find their sink once; then one read serves all six callers.
        expect(sinkReads()).toBe(3);
        expect(states.every((s) => s === states[0])).toBe(true);
        expect(states[0]).toMatchObject({ volume: 60 });
    });

    it("a set that starts while the last run's read is still out gets a fresh read of its own", async () => {
        const pactl = fakePactl({ sinks: [onboard()], inputs: [], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        const first = c.apply({ volume: 10 });
        await vi.waitFor(() => expect(pactl.calls.length).toBe(1));
        const second = c.apply({ volume: 70 });
        expect(await second).toMatchObject({ volume: 70 });
        await first;
    });

    it("keeps a mute that arrived in the same burst as a level", async () => {
        const pactl = fakePactl({ sinks: [onboard()], inputs: [], defaultSink: "alsa_output.onboard" });
        const c = new VolumeController({ run: pactl.run, platform: "linux" });
        await Promise.all([c.apply({ volume: 10 }), c.apply({ muted: true }), c.apply({ volume: 25 })]);
        expect(pactl.calls).toEqual([
            ["set-sink-volume", "57", "10%"],
            ["set-sink-volume", "57", "25%"],
            ["set-sink-mute", "57", "1"],
        ]);
    });

    it("survives a failed set and still reports the state", async () => {
        const pactl = fakePactl({ sinks: [onboard()], inputs: [], defaultSink: "alsa_output.onboard" });
        const run = vi.fn(async (args: string[]) => {
            if (args[0] === "set-sink-volume") {throw new Error("Failure: No such entity");}
            return pactl.run(args);
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const c = new VolumeController({ run, platform: "linux" });
        expect(await c.apply({ volume: 90 })).toMatchObject({ available: true, volume: 40 });
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe("watchVolume", () => {
    function fakeSpawn() {
        const children: (EventEmitter & { stdout: EventEmitter; kill: () => void })[] = [];
        const spawnImpl = vi.fn(() => {
            const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
            children.push(child);
            return child;
        });
        return { children, spawnImpl };
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("fires once, debounced, for a burst of sink and stream events", () => {
        const { children, spawnImpl } = fakeSpawn();
        const onEvent = vi.fn();
        watchVolume(onEvent, { spawnImpl, debounceMs: 60 });
        children[0].stdout.emit("data", Buffer.from("Event 'change' on sink #57\nEvent 'new' on sink-input #2549\n"));
        children[0].stdout.emit("data", Buffer.from("Event 'change' on server\n"));
        vi.advanceTimersByTime(59);
        expect(onEvent).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it("ignores events that can't change the volume, and lines split across chunks", () => {
        const { children, spawnImpl } = fakeSpawn();
        const onEvent = vi.fn();
        watchVolume(onEvent, { spawnImpl, debounceMs: 10 });
        children[0].stdout.emit("data", Buffer.from("Event 'change' on source #3\nEvent 'new' on client #9\nEvent 'change' on si"));
        vi.advanceTimersByTime(20);
        expect(onEvent).not.toHaveBeenCalled();
        children[0].stdout.emit("data", Buffer.from("nk #57\n"));
        vi.advanceTimersByTime(20);
        expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it("does not read a sink-input event as a source-output one", () => {
        const { children, spawnImpl } = fakeSpawn();
        const onEvent = vi.fn();
        watchVolume(onEvent, { spawnImpl, debounceMs: 10 });
        children[0].stdout.emit("data", Buffer.from("Event 'change' on source-output #12\n"));
        vi.advanceTimersByTime(20);
        expect(onEvent).not.toHaveBeenCalled();
    });

    it("restarts pactl when it exits, backing off", () => {
        const { children, spawnImpl } = fakeSpawn();
        watchVolume(vi.fn(), { spawnImpl });
        children[0].emit("exit");
        vi.advanceTimersByTime(999);
        expect(spawnImpl).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(spawnImpl).toHaveBeenCalledTimes(2);
        children[1].emit("exit");
        vi.advanceTimersByTime(1999);
        expect(spawnImpl).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(1);
        expect(spawnImpl).toHaveBeenCalledTimes(3);
    });

    it("runs pactl under setpriv --pdeathsig, so it dies with a killed Electron; plain pactl without setpriv", () => {
        const { spawnImpl } = fakeSpawn();
        watchVolume(vi.fn(), { spawnImpl, setpriv: "/usr/bin/setpriv" });
        expect(spawnImpl).toHaveBeenLastCalledWith("/usr/bin/setpriv", ["--pdeathsig", "TERM", "--", "pactl", "subscribe"], expect.anything());
        watchVolume(vi.fn(), { spawnImpl, setpriv: null });
        expect(spawnImpl).toHaveBeenLastCalledWith("pactl", ["subscribe"], expect.anything());
        expect(subscribeCommand(null)).toEqual(["pactl", ["subscribe"]]);
        expect(findSetpriv((p: string) => p === "/bin/setpriv")).toBe("/bin/setpriv");
        expect(findSetpriv(() => false)).toBeNull();
    });

    it("stops for good: kills pactl and doesn't restart it", () => {
        const { children, spawnImpl } = fakeSpawn();
        const onEvent = vi.fn();
        const watcher = watchVolume(onEvent, { spawnImpl, debounceMs: 10 });
        children[0].stdout.emit("data", Buffer.from("Event 'change' on sink #57\n"));
        watcher.stop();
        expect(children[0].kill).toHaveBeenCalled();
        children[0].emit("exit");
        vi.advanceTimersByTime(120000);
        expect(spawnImpl).toHaveBeenCalledTimes(1);
        expect(onEvent).not.toHaveBeenCalled();
    });
});

describe("volume helpers", () => {
    it("clampVolume: whole percent in 0-100, non-numbers read as 0", () => {
        expect(clampVolume(42.4)).toBe(42);
        expect(clampVolume(-3)).toBe(0);
        expect(clampVolume(140)).toBe(100);
        expect(clampVolume(NaN)).toBe(0);
        expect(clampVolume(Infinity)).toBe(0);
    });

    it("volumeGlyph: muted or 0 shows mute, then low / medium / high", () => {
        expect(volumeGlyph(50, true)).toBe("volume-mute");
        expect(volumeGlyph(0, false)).toBe("volume-mute");
        expect(volumeGlyph(20, false)).toBe("volume-low");
        expect(volumeGlyph(50, false)).toBe("volume-medium");
        expect(volumeGlyph(90, false)).toBe("volume-high");
    });

    it("volumeAfterKey: arrows step 5, page keys 10, Home/End go to the ends, other keys are ignored", () => {
        expect(volumeAfterKey(50, "ArrowUp")).toBe(55);
        expect(volumeAfterKey(50, "ArrowLeft")).toBe(45);
        expect(volumeAfterKey(98, "ArrowRight")).toBe(100);
        expect(volumeAfterKey(50, "PageDown")).toBe(40);
        expect(volumeAfterKey(50, "Home")).toBe(0);
        expect(volumeAfterKey(50, "End")).toBe(100);
        expect(volumeAfterKey(50, "a")).toBeNull();
    });

    it("volumeAfterWheel: one notch is 2%, up raises it", () => {
        expect(volumeAfterWheel(50, -120)).toBe(52);
        expect(volumeAfterWheel(50, 3)).toBe(48);
        expect(volumeAfterWheel(1, 100)).toBe(0);
        expect(volumeAfterWheel(50, 0)).toBe(50);
    });
});
