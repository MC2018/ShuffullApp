import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

// desktop/*.js are the Electron main process's CommonJS modules; neither imports Electron, so they run here.
const require = createRequire(import.meta.url);
const { MediaKeyRouter, SETTLE_MS, startMediaKeyRouter } = require("../desktop/mediaKeys.js");
const dbus = require("../desktop/dbus.js");

const OWN = "org.mpris.MediaPlayer2.chromium.instance1";
const YT = "org.mpris.MediaPlayer2.firefox.instance_1_120";
const SETTLED = SETTLE_MS + 1;

function router() {
    return new MediaKeyRouter({ preferred: OWN });
}

describe("MediaKeyRouter: the player touched last gets the keys", () => {
    it("follows whichever player was started last, in either order", () => {
        const r = router();
        r.appeared(OWN);
        r.appeared(YT);
        r.observeInitial(OWN, "Stopped", 0);
        r.observeInitial(YT, "Paused", 0);

        r.observe(YT, "Playing", 1000);
        expect(r.target(1000 + SETTLED)).toBe(YT);

        r.observe(OWN, "Playing", 3000);
        expect(r.target(3000 + SETTLED)).toBe(OWN);

        r.observe(YT, "Playing", 5000); // already Playing as far as we know: not a change
        r.observe(YT, "Paused", 5100);
        r.observe(YT, "Playing", 7000);
        expect(r.target(7000 + SETTLED)).toBe(YT);
    });

    it("a manual pause makes that player the target", () => {
        const r = router();
        r.appeared(OWN);
        r.appeared(YT);
        r.observe(OWN, "Playing", 0);
        r.observe(YT, "Playing", 1000);
        r.observe(OWN, "Paused", 2000);
        expect(r.target(2000 + SETTLED)).toBe(OWN);
    });

    it("ignores a Playing -> Paused -> Playing blip, as at a track change", () => {
        const r = router();
        r.appeared(OWN);
        r.appeared(YT);
        r.observe(YT, "Playing", 0);
        r.observe(OWN, "Playing", 1000);
        expect(r.target(1000 + SETTLED)).toBe(OWN);

        r.observe(YT, "Paused", 5000);
        r.observe(YT, "Playing", 5050);
        expect(r.target(5050 + SETTLED)).toBe(OWN);
    });

    it("does not switch until a change has held for the settle time", () => {
        const r = router();
        r.appeared(OWN);
        r.appeared(YT);
        r.observe(OWN, "Playing", 0);
        r.observe(YT, "Playing", 1000);
        expect(r.target(1000 + SETTLE_MS - 1)).toBe(OWN);
        expect(r.target(1000 + SETTLED)).toBe(YT);
    });

    it("a player that shows up already Playing counts as touched (Firefox only publishes once media starts)", () => {
        const r = router();
        r.appeared(OWN);
        r.observe(OWN, "Playing", 0);
        r.appeared(YT);
        r.observeInitial(YT, "Playing", 5000);
        expect(r.target(5000 + SETTLED)).toBe(YT);
    });

    it("a player that shows up Paused does not take the keys", () => {
        const r = router();
        r.appeared(OWN);
        r.observe(OWN, "Playing", 0);
        r.appeared(YT);
        r.observeInitial(YT, "Paused", 5000);
        expect(r.target(5000 + SETTLED)).toBe(OWN);
    });

    it("ignores the initial read when a change arrived first", () => {
        const r = router();
        r.appeared(YT);
        r.observe(YT, "Playing", 0);
        r.observeInitial(YT, "Paused", 10); // stale: read before the change
        expect(r.target(SETTLED + 10)).toBe(YT);
        expect(r.players.get(YT).settled).toBe("Playing");
    });

    it("falls back to the previously touched player when the target quits", () => {
        const r = router();
        r.appeared(OWN);
        r.appeared(YT);
        r.observe(OWN, "Playing", 0);
        r.observe(YT, "Playing", 1000);
        expect(r.target(1000 + SETTLED)).toBe(YT);
        r.vanished(YT);
        expect(r.target(1000 + SETTLED)).toBe(OWN);
    });

    it("before anything is touched: a playing player, else our own, else any, else none", () => {
        const r = router();
        expect(r.target(0)).toBeNull();

        r.appeared(YT);
        r.observeInitial(YT, "Paused", 0);
        expect(r.target(SETTLED)).toBe(YT);

        r.appeared(OWN);
        r.observeInitial(OWN, "Stopped", 0);
        expect(r.target(SETTLED)).toBe(OWN);
    });

    it("ignores reports for players it was never told about", () => {
        const r = router();
        r.observe(YT, "Playing", 0);
        expect(r.target(SETTLED)).toBeNull();
    });
});

describe("dbus wire format", () => {
    it("round-trips a signal with nested variants, dicts and 64-bit values", () => {
        const changed = {
            PlaybackStatus: ["s", "Playing"],
            Metadata: ["a{sv}", { "xesam:title": ["s", "Song"], "mpris:length": ["x", 123456789012n], "xesam:artist": ["as", ["A", "B"]] }],
            Volume: ["d", 0.5],
            CanGoNext: ["b", true],
        };
        const bytes = dbus.encodeMessage({
            type: dbus.MESSAGE_TYPE.SIGNAL,
            serial: 7,
            path: "/org/mpris/MediaPlayer2",
            iface: "org.freedesktop.DBus.Properties",
            member: "PropertiesChanged",
            signature: "sa{sv}as",
            body: ["org.mpris.MediaPlayer2.Player", changed, []],
        });
        expect(bytes.length).toBe(dbus.messageLength(bytes));

        const msg = dbus.decodeMessage(bytes);
        expect(msg).toMatchObject({ type: dbus.MESSAGE_TYPE.SIGNAL, serial: 7, member: "PropertiesChanged", signature: "sa{sv}as" });
        const [iface, props, invalidated] = msg.body;
        expect(iface).toBe("org.mpris.MediaPlayer2.Player");
        expect(props).toEqual({
            PlaybackStatus: "Playing",
            Metadata: { "xesam:title": "Song", "mpris:length": 123456789012n, "xesam:artist": ["A", "B"] },
            Volume: 0.5,
            CanGoNext: true,
        });
        expect(invalidated).toEqual([]);
    });

    it("pads an empty array of 8-aligned elements and still reads what follows", () => {
        const bytes = dbus.encodeMessage({
            type: dbus.MESSAGE_TYPE.METHOD_RETURN,
            serial: 1,
            replySerial: 9,
            signature: "ya(ss)u",
            body: [1, [], 42],
        });
        expect(dbus.decodeMessage(bytes).body).toEqual([1, [], 42]);
    });

    it("decodes a big-endian message", () => {
        // A method return, serial 2, reply to 1, signature "s", body "hi" - written by hand in big-endian.
        const fields = Buffer.from([
            5, 1, 0x75, 0, 0, 0, 0, 1, // REPLY_SERIAL, variant "u", 1
            8, 1, 0x67, 0, 1, 0x73, 0, // SIGNATURE, variant "g", "s"
        ]);
        const header = Buffer.alloc(16);
        header.write("B", 0, "latin1");
        header[1] = 2;
        header[3] = 1;
        header.writeUInt32BE(7, 4); // body length
        header.writeUInt32BE(2, 8);
        header.writeUInt32BE(fields.length, 12);
        const pad = Buffer.alloc((8 - ((16 + fields.length) % 8)) % 8);
        const body = Buffer.from([0, 0, 0, 2, 0x68, 0x69, 0]);
        const msg = dbus.decodeMessage(Buffer.concat([header, fields, pad, body]));
        expect(msg).toMatchObject({ type: 2, serial: 2, replySerial: 1, body: ["hi"] });
    });

    it("finds the socket in a bus address", () => {
        expect(dbus.socketPathFromAddress("unix:path=/run/user/1000/bus")).toBe("/run/user/1000/bus");
        expect(dbus.socketPathFromAddress("unix:abstract=/tmp/dbus-x,guid=abc")).toBe("\0/tmp/dbus-x");
        expect(dbus.socketPathFromAddress("tcp:host=x,port=1;unix:path=/a%20b")).toBe("/a b");
        expect(dbus.socketPathFromAddress(undefined)).toBeNull();
    });
});

describe("SessionBus framing", () => {
    function fakeBus() {
        const socket = Object.assign(new EventEmitter(), { written: [] as Buffer[], write(b: Buffer) { this.written.push(b); } });
        const bus = new dbus.SessionBus(socket);
        bus.attach(Buffer.alloc(0));
        return { bus, socket };
    }

    it("reassembles messages split across and packed into chunks, and matches replies to calls", async () => {
        const { bus, socket } = fakeBus();
        const signals: unknown[] = [];
        bus.on("signal", (m: { member: string }) => signals.push(m.member));

        const reply = bus.call({ destination: "x.y", path: "/", iface: "x.y", member: "Get" });
        const serial = dbus.decodeMessage(socket.written[0]).serial;

        const sig = dbus.encodeMessage({ type: dbus.MESSAGE_TYPE.SIGNAL, serial: 1, path: "/a", iface: "a.b", member: "Ping" });
        const ret = dbus.encodeMessage({ type: dbus.MESSAGE_TYPE.METHOD_RETURN, serial: 2, replySerial: serial, signature: "s", body: ["ok"] });
        const all = Buffer.concat([sig, ret]);
        socket.emit("data", all.subarray(0, 5));
        socket.emit("data", all.subarray(5, sig.length + 3));
        socket.emit("data", all.subarray(sig.length + 3));

        await expect(reply).resolves.toEqual(["ok"]);
        expect(signals).toEqual(["Ping"]);
    });

    it("rejects a call with the D-Bus error, and every pending call when the socket closes", async () => {
        const { bus, socket } = fakeBus();
        const failing = bus.call({ destination: "x.y", path: "/", iface: "x.y", member: "A" });
        const orphaned = bus.call({ destination: "x.y", path: "/", iface: "x.y", member: "B" });
        const serial = dbus.decodeMessage(socket.written[0]).serial;

        socket.emit("data", dbus.encodeMessage({
            type: dbus.MESSAGE_TYPE.ERROR,
            serial: 3,
            replySerial: serial,
            errorName: "org.freedesktop.DBus.Error.ServiceUnknown",
            signature: "s",
            body: ["nope"],
        }));
        await expect(failing).rejects.toThrow("org.freedesktop.DBus.Error.ServiceUnknown: nope");

        socket.emit("close");
        await expect(orphaned).rejects.toThrow("closed");
    });

    it("times out a call that never gets a reply, and forgets it", async () => {
        vi.useFakeTimers();
        try {
            const { bus } = fakeBus();
            const hung = bus.call({ destination: "x.y", path: "/", iface: "x.y", member: "Get", timeoutMs: 1000 });
            const assertion = expect(hung).rejects.toThrow("x.y.Get on x.y got no reply within 1000 ms");
            await vi.advanceTimersByTimeAsync(1000);
            await assertion;
            expect(bus.pending.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("startMediaKeyRouter: the bus wiring", () => {
    const PLAYER_PATH = "/org/mpris/MediaPlayer2";
    const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
    const KEYS_PATH = "/org/gnome/SettingsDaemon/MediaKeys";
    const KEYS_IFACE = "org.gnome.SettingsDaemon.MediaKeys";
    const OWN_PID = 1; // so our own player is OWN

    type Call = { destination?: string; path?: string; iface?: string; member: string; body?: unknown[] };

    class FakeBus extends EventEmitter {
        calls: Call[] = [];
        owners: Record<string, string> = { [OWN]: ":1.10", [YT]: ":1.20" };
        statuses: Record<string, string> = { [OWN]: "Paused", [YT]: "Paused" };
        failGrab = false;
        closed = false;

        call(opts: Call) {
            this.calls.push(opts);
            switch (opts.member) {
                case "ListNames": return Promise.resolve([[...Object.keys(this.owners), "org.freedesktop.Notifications"]]);
                case "GetNameOwner": return Promise.resolve([this.owners[opts.body![0] as string]]);
                case "Get": return Promise.resolve([this.statuses[opts.destination!]]);
                case "GrabMediaPlayerKeys": return this.failGrab ? Promise.reject(new Error("ServiceUnknown")) : Promise.resolve([]);
                default: return Promise.resolve([]);
            }
        }
        addMatch(rule: string) {
            return this.call({ member: "AddMatch", body: [rule] });
        }
        close() {
            this.closed = true;
            this.emit("close");
        }
        status(sender: string, PlaybackStatus: string, iface = PLAYER_IFACE) {
            this.emit("signal", { iface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", path: PLAYER_PATH, sender, body: [iface, { PlaybackStatus }, []] });
        }
        key(key: string, app = "Shuffull") {
            this.emit("signal", { iface: KEYS_IFACE, member: "MediaPlayerKeyPressed", path: KEYS_PATH, body: [app, key] });
        }
        ownerChanged(name: string, oldOwner: string, newOwner: string) {
            this.emit("signal", { iface: "org.freedesktop.DBus", member: "NameOwnerChanged", path: "/org/freedesktop/DBus", body: [name, oldOwner, newOwner] });
        }
        playerCalls() {
            return this.calls.filter((c) => c.iface === PLAYER_IFACE).map((c) => `${c.destination} ${c.member}`);
        }
        grabs() {
            return this.calls.filter((c) => c.member === "GrabMediaPlayerKeys");
        }
    }

    const quiet = { log: () => {}, warn: () => {} };
    let bus: FakeBus;

    async function start() {
        const handle = await startMediaKeyRouter({ log: quiet, connect: async () => bus, platform: "linux", hasBus: true, ownPid: OWN_PID });
        await vi.advanceTimersByTimeAsync(0); // let the initial status reads land
        return handle;
    }
    const settle = () => vi.advanceTimersByTimeAsync(SETTLED);

    beforeEach(() => {
        vi.useFakeTimers();
        bus = new FakeBus();
    });
    afterEach(() => vi.useRealTimers());

    it("grabs the keys as Shuffull once its match rules are in", async () => {
        await start();
        expect(bus.grabs()).toEqual([expect.objectContaining({ path: KEYS_PATH, iface: KEYS_IFACE, body: ["Shuffull", 0] })]);
        const lastMatch = bus.calls.map((c) => c.member).lastIndexOf("AddMatch");
        expect(lastMatch).toBeLessThan(bus.calls.findIndex((c) => c.member === "GrabMediaPlayerKeys"));
    });

    it("sends each key to the player whose status changed last, found by its unique name", async () => {
        await start();
        bus.status(":1.20", "Playing");
        await settle();
        bus.key("Next");
        bus.status(":1.10", "Playing");
        await settle();
        bus.key("Play");
        bus.key("Previous");
        expect(bus.playerCalls()).toEqual([`${YT} Next`, `${OWN} PlayPause`, `${OWN} Previous`]);
    });

    it("ignores presses for another app, keys it has no method for, and other interfaces' changes", async () => {
        await start();
        bus.status(":1.20", "Playing");
        await settle();
        bus.status(":1.10", "Playing", "org.mpris.MediaPlayer2");
        await settle();
        bus.key("Next", "Rhythmbox");
        bus.key("Rewind");
        bus.key("Pause");
        expect(bus.playerCalls()).toEqual([`${YT} Pause`]);
    });

    it("follows players that appear and quit", async () => {
        await start();
        bus.status(":1.10", "Playing");
        await settle();

        const NEW = "org.mpris.MediaPlayer2.vlc";
        bus.owners[NEW] = ":1.30";
        bus.statuses[NEW] = "Playing";
        bus.ownerChanged(NEW, "", ":1.30");
        await settle();
        bus.key("Next");

        bus.ownerChanged(NEW, ":1.30", "");
        bus.key("Next");
        expect(bus.playerCalls()).toEqual([`${NEW} Next`, `${OWN} Next`]);
    });

    it("grabs again when Cinnamon's daemon restarts", async () => {
        await start();
        bus.ownerChanged("org.gnome.SettingsDaemon", ":1.5", "");
        bus.ownerChanged("org.gnome.SettingsDaemon", "", ":1.99");
        expect(bus.grabs()).toHaveLength(2);
    });

    it("does nothing off Linux or without a session bus", async () => {
        const connect = vi.fn();
        expect(await startMediaKeyRouter({ log: quiet, connect, platform: "win32", hasBus: true })).toBeNull();
        expect(await startMediaKeyRouter({ log: quiet, connect, platform: "linux", hasBus: false })).toBeNull();
        expect(connect).not.toHaveBeenCalled();
    });

    it("closes the bus and rejects when the grab fails", async () => {
        bus.failGrab = true;
        await expect(startMediaKeyRouter({ log: quiet, connect: async () => bus, platform: "linux", hasBus: true })).rejects.toThrow("ServiceUnknown");
        expect(bus.closed).toBe(true);
    });

    it("stop() closes the bus, which drops the grab", async () => {
        const handle = await start();
        handle.stop();
        expect(bus.closed).toBe(true);
    });
});
