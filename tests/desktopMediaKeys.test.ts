import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

// desktop/*.js are the Electron main process's CommonJS modules; neither imports Electron, so they run here.
const require = createRequire(import.meta.url);
const { MediaKeyRouter, SETTLE_MS } = require("../desktop/mediaKeys.js");
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
});
