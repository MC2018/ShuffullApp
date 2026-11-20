const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");

/**
 * The volume of the speaker Shuffull plays on: the level the system Sound settings shows for that device.
 *
 * WHICH SPEAKER. Not the default output. PipeWire remembers a per-app output by `application.name`, which is why
 * main.js names the app "Shuffull" (ShuffullApp#211): this machine plays Shuffull on a Bluetooth amp while the
 * default sink stays the onboard card. Moving `@DEFAULT_SINK@` would change a speaker nobody is listening to. So
 * we follow the sink our own stream (sink-input) is attached to, and remember it: Chromium closes the stream a
 * while after playback pauses, and the slider must not jump to another device's level just because the music
 * stopped. Only before Shuffull has played at all does it fall back to the default output.
 *
 * HOW. `pactl` (PulseAudio's CLI, served by pipewire-pulse) rather than a native binding: it is on every desktop
 * that has sound, and three commands cover it. `pactl subscribe` reports changes made anywhere else (the Sound
 * settings, the keyboard's volume keys, the panel applet), so the slider follows them.
 *
 * Linux only. Anywhere else, or without pactl, `read()` reports `available: false` and the app hides the slider.
 *
 * 100% is the cap. pactl allows boosting past it (Sound settings' "over-amplification"); we never set more than
 * 100%, and a level someone else pushed higher shows as 100% here.
 */

const APP_NAME = "Shuffull";
const PA_NORM = 65536; // PA_VOLUME_NORM: 100%

/** Runs `pactl <args>` and resolves its stdout. Swappable in tests. */
function defaultRun(args) {
    return new Promise((resolve, reject) => {
        execFile("pactl", args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

/** Average channel level of a pactl JSON `volume` object, as a whole percent of 100%. */
function volumePercent(volume) {
    const channels = Object.values(volume ?? {});
    if (channels.length === 0) return 0;
    const mean = channels.reduce((sum, ch) => sum + (Number(ch?.value) || 0), 0) / channels.length;
    return Math.round((mean / PA_NORM) * 100);
}

/**
 * The sink Shuffull's audio is on right now, or null when it has no stream. A playing (uncorked) stream wins over
 * a paused one, so a second, idle Shuffull stream can't pull the slider to the wrong speaker.
 */
function findOwnSink(sinkInputs) {
    const own = (sinkInputs ?? []).filter((input) => input?.properties?.["application.name"] === APP_NAME);
    const best = own.find((input) => !input.corked) ?? own[0];
    return best ? best.sink : null;
}

/** pactl reports `mute` as a boolean, but older builds print "yes"/"no". */
function isMuted(sink) {
    return sink.mute === true || sink.mute === "yes";
}

class VolumeController {
    constructor({ run = defaultRun, platform = process.platform } = {}) {
        this.run = run;
        this.supported = platform === "linux";
        // The sink index Shuffull last played on. Kept after its stream closes (see the header).
        this.lastSink = null;
        // Settings are applied one at a time, latest wins: a slider drag sends dozens of levels a second, and
        // queuing every one would leave the speaker catching up long after the drag ended.
        this.pending = null;
        this.applying = null;
    }

    async json(args) {
        return JSON.parse(await this.run(["-f", "json", ...args]));
    }

    /** The sink to control: Shuffull's current one, else the one it last used, else the default output. */
    async target() {
        const sinks = await this.json(["list", "sinks"]);
        const own = findOwnSink(await this.json(["list", "sink-inputs"]));
        if (own != null) this.lastSink = own;

        let sink = sinks.find((s) => s.index === this.lastSink);
        if (!sink) {
            // The remembered device went away (a Bluetooth speaker turned off): PipeWire moved the stream, and
            // with no stream right now the default output is where it will go next.
            this.lastSink = null;
            const defaultName = (await this.run(["get-default-sink"])).trim();
            sink = sinks.find((s) => s.name === defaultName) ?? sinks[0];
        }
        return sink ?? null;
    }

    /** `{ available: true, volume, muted, device }`, or `{ available: false }` where there is nothing to control. */
    async read() {
        if (!this.supported) return { available: false };
        try {
            const sink = await this.target();
            if (!sink) return { available: false };
            return { available: true, volume: Math.min(100, volumePercent(sink.volume)), muted: isMuted(sink), device: sink.description || sink.name };
        } catch {
            return { available: false };
        }
    }

    /** Sets the level (0-100, rounded and capped) and/or mute. Resolves the state afterwards. */
    async apply(change) {
        if (!this.supported) return { available: false };
        this.pending = { ...this.pending, ...change };
        if (!this.applying) {
            this.applying = (async () => {
                try {
                    while (this.pending) {
                        const next = this.pending;
                        this.pending = null;
                        await this.applyNow(next);
                    }
                } finally {
                    this.applying = null;
                }
            })();
        }
        await this.applying.catch(() => {});
        return this.read();
    }

    async applyNow({ volume, muted }) {
        try {
            const sink = await this.target();
            if (!sink) return;
            if (typeof volume === "number" && Number.isFinite(volume)) {
                const level = Math.round(Math.max(0, Math.min(100, volume)));
                await this.run(["set-sink-volume", String(sink.index), `${level}%`]);
            }
            if (typeof muted === "boolean") {
                await this.run(["set-sink-mute", String(sink.index), muted ? "1" : "0"]);
            }
        } catch (err) {
            console.warn(`[volume] could not change the volume: ${err.message}`);
        }
    }
}

/** util-linux's setpriv, if this system has it. */
function findSetpriv(exists = fs.existsSync) {
    return ["/usr/bin/setpriv", "/bin/setpriv"].find((path) => exists(path)) ?? null;
}

/**
 * The command that runs `pactl subscribe`. A long-lived child outlives an Electron main process that is killed or
 * crashes (will-quit never runs), and an idle `pactl subscribe` never notices: one orphan per kill or update, for
 * ever. Through `setpriv --pdeathsig TERM` the kernel ends it when its parent dies. Without setpriv, plain pactl.
 */
function subscribeCommand(setpriv) {
    return setpriv ? [setpriv, ["--pdeathsig", "TERM", "--", "pactl", "subscribe"]] : ["pactl", ["subscribe"]];
}

/**
 * Calls `onEvent` whenever a sink or stream changes anywhere (`pactl subscribe`), debounced. Restarts pactl if it
 * exits (pipewire-pulse restarted), backing off to a minute. Returns `stop()`.
 */
function watchVolume(onEvent, { spawnImpl = spawn, debounceMs = 60, setpriv = findSetpriv() } = {}) {
    const [command, args] = subscribeCommand(setpriv);
    let child = null;
    let stopped = false;
    let timer = null;
    let retryMs = 1000;

    const fire = () => {
        clearTimeout(timer);
        timer = setTimeout(onEvent, debounceMs);
    };

    const start = () => {
        if (stopped) return;
        let buffered = "";
        try {
            child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "ignore"] });
        } catch {
            return;
        }
        child.on("error", () => {}); // no pactl: read() already reports the slider unavailable
        child.stdout?.on("data", (chunk) => {
            retryMs = 1000;
            buffered += chunk.toString();
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            // "Event 'change' on sink #57", "Event 'new' on sink-input #2549", "Event 'change' on server".
            if (lines.some((line) => / on (sink|sink-input|server)\b/.test(line))) fire();
        });
        child.on("exit", () => {
            child = null;
            if (stopped) return;
            setTimeout(start, retryMs);
            retryMs = Math.min(retryMs * 2, 60000);
        });
    };

    start();
    return {
        stop() {
            stopped = true;
            clearTimeout(timer);
            child?.kill();
        },
    };
}

module.exports = { VolumeController, watchVolume, findOwnSink, findSetpriv, subscribeCommand, volumePercent, APP_NAME };
