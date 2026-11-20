const net = require("node:net");
const { EventEmitter } = require("node:events");

/**
 * A minimal D-Bus session-bus client: just enough to call methods, receive signals and add match rules.
 *
 * Why not a library (dbus-next and friends): the installed desktop build is `desktop/*.js` plus an Electron
 * binary, with no node_modules beside it, so everything under desktop/ uses Node built-ins only. The wire format
 * is small enough to own. What is deliberately left out: big-endian WRITING (we always send little-endian, which
 * every bus accepts), unix file descriptors (`h`), and serving methods (calls to us get an UnknownMethod error).
 *
 * Values map to JS as: integers -> number (64-bit -> BigInt), strings/object paths/signatures -> string,
 * arrays -> Array, dicts -> plain object, structs -> Array. A variant READS as its bare value; to WRITE one,
 * pass `[signature, value]`.
 */

const MESSAGE_TYPE = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 };
const FLAG_NO_REPLY_EXPECTED = 0x1;
// libdbus defaults to 25 s. Every call here is a local property read or a key press, so 5 s is already generous.
const CALL_TIMEOUT_MS = 5000;

const HEADER_FIELD = { PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR_NAME: 4, REPLY_SERIAL: 5, DESTINATION: 6, SENDER: 7, SIGNATURE: 8 };

const ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, "(": 8, "{": 8, v: 1 };

/** Index just past the single complete type that starts at `sig[i]`. */
function typeEnd(sig, i) {
    const c = sig[i];
    if (c === "a") {
        return typeEnd(sig, i + 1);
    }
    if (c === "(" || c === "{") {
        const close = c === "(" ? ")" : "}";
        let j = i + 1;
        while (sig[j] !== close) {
            if (j >= sig.length) {
                throw new Error(`Unterminated D-Bus type in '${sig}'`);
            }
            j = typeEnd(sig, j);
        }
        return j + 1;
    }
    if (!(c in ALIGN)) {
        throw new Error(`Unsupported D-Bus type '${c}' in '${sig}'`);
    }
    return i + 1;
}

/** Splits a signature into its complete types: "sa{sv}as" -> ["s", "a{sv}", "as"]. */
function splitTypes(sig) {
    const out = [];
    for (let i = 0; i < sig.length; ) {
        const end = typeEnd(sig, i);
        out.push(sig.slice(i, end));
        i = end;
    }
    return out;
}

class Writer {
    constructor() {
        this.buf = Buffer.alloc(256);
        this.len = 0;
    }

    ensure(n) {
        if (this.len + n <= this.buf.length) {
            return;
        }
        let size = this.buf.length * 2;
        while (size < this.len + n) {
            size *= 2;
        }
        const next = Buffer.alloc(size);
        this.buf.copy(next, 0, 0, this.len);
        this.buf = next;
    }

    align(n) {
        const pad = (n - (this.len % n)) % n;
        this.ensure(pad);
        this.buf.fill(0, this.len, this.len + pad);
        this.len += pad;
    }

    fixed(size, method, value) {
        this.align(size);
        this.ensure(size);
        this.buf[method](value, this.len);
        this.len += size;
    }

    raw(bytes) {
        this.ensure(bytes.length);
        bytes.copy(this.buf, this.len);
        this.len += bytes.length;
    }

    write(type, value) {
        switch (type[0]) {
            case "y": return this.fixed(1, "writeUInt8", value);
            case "b": return this.fixed(4, "writeUInt32LE", value ? 1 : 0);
            case "n": return this.fixed(2, "writeInt16LE", value);
            case "q": return this.fixed(2, "writeUInt16LE", value);
            case "i": return this.fixed(4, "writeInt32LE", value);
            case "u": return this.fixed(4, "writeUInt32LE", value);
            case "x": return this.fixed(8, "writeBigInt64LE", BigInt(value));
            case "t": return this.fixed(8, "writeBigUInt64LE", BigInt(value));
            case "d": return this.fixed(8, "writeDoubleLE", value);
            case "s":
            case "o": {
                const bytes = Buffer.from(value, "utf8");
                this.fixed(4, "writeUInt32LE", bytes.length);
                this.raw(bytes);
                return this.fixed(1, "writeUInt8", 0);
            }
            case "g": {
                const bytes = Buffer.from(value, "ascii");
                this.fixed(1, "writeUInt8", bytes.length);
                this.raw(bytes);
                return this.fixed(1, "writeUInt8", 0);
            }
            case "v": {
                const [sig, inner] = value;
                this.write("g", sig);
                return this.write(sig, inner);
            }
            case "a": {
                const elem = type.slice(1);
                this.fixed(4, "writeUInt32LE", 0);
                const lengthAt = this.len - 4;
                // Padding to the element's alignment comes after the length and is not counted in it, even when
                // the array is empty.
                this.align(ALIGN[elem[0]]);
                const start = this.len;
                const items = elem[0] === "{" && !Array.isArray(value) ? Object.entries(value) : value;
                for (const item of items) {
                    this.write(elem, item);
                }
                this.buf.writeUInt32LE(this.len - start, lengthAt);
                return;
            }
            case "(":
            case "{": {
                this.align(8);
                splitTypes(type.slice(1, -1)).forEach((t, k) => this.write(t, value[k]));
                return;
            }
            default:
                throw new Error(`Unsupported D-Bus type '${type}'`);
        }
    }

    bytes() {
        return this.buf.subarray(0, this.len);
    }
}

class Reader {
    /** `buf` is the whole message: alignment is measured from its start. */
    constructor(buf, pos, littleEndian) {
        this.buf = buf;
        this.pos = pos;
        this.le = littleEndian;
    }

    align(n) {
        this.pos += (n - (this.pos % n)) % n;
    }

    fixed(size, method) {
        this.align(size);
        if (this.pos + size > this.buf.length) {
            throw new Error("D-Bus message truncated");
        }
        const value = this.buf[method + (size > 1 ? (this.le ? "LE" : "BE") : "")](this.pos);
        this.pos += size;
        return value;
    }

    string(lengthSize) {
        const length = lengthSize === 1 ? this.fixed(1, "readUInt8") : this.fixed(4, "readUInt32");
        if (this.pos + length + 1 > this.buf.length) {
            throw new Error("D-Bus message truncated");
        }
        const value = this.buf.toString("utf8", this.pos, this.pos + length);
        this.pos += length + 1; // + the trailing NUL
        return value;
    }

    read(type) {
        switch (type[0]) {
            case "y": return this.fixed(1, "readUInt8");
            case "b": return this.fixed(4, "readUInt32") !== 0;
            case "n": return this.fixed(2, "readInt16");
            case "q": return this.fixed(2, "readUInt16");
            case "i": return this.fixed(4, "readInt32");
            case "u": return this.fixed(4, "readUInt32");
            case "x": return this.fixed(8, "readBigInt64");
            case "t": return this.fixed(8, "readBigUInt64");
            case "d": return this.fixed(8, "readDouble");
            case "s":
            case "o": return this.string(4);
            case "g": return this.string(1);
            case "v": return this.read(this.string(1));
            case "a": {
                const elem = type.slice(1);
                const length = this.fixed(4, "readUInt32");
                this.align(ALIGN[elem[0]]);
                const end = this.pos + length;
                if (end > this.buf.length) {
                    throw new Error("D-Bus message truncated");
                }
                const items = [];
                while (this.pos < end) {
                    items.push(this.read(elem));
                }
                return elem[0] === "{" ? Object.fromEntries(items) : items;
            }
            case "(":
            case "{": {
                this.align(8);
                return splitTypes(type.slice(1, -1)).map((t) => this.read(t));
            }
            default:
                throw new Error(`Unsupported D-Bus type '${type}'`);
        }
    }
}

function encodeMessage({ type, flags = 0, serial, path, iface, member, errorName, replySerial, destination, signature = "", body = [] }) {
    const bodyWriter = new Writer();
    // The body starts 8-aligned within the message, so aligning relative to the body's own start is the same thing.
    splitTypes(signature).forEach((t, k) => bodyWriter.write(t, body[k]));

    const fields = [];
    if (path) fields.push([HEADER_FIELD.PATH, ["o", path]]);
    if (iface) fields.push([HEADER_FIELD.INTERFACE, ["s", iface]]);
    if (member) fields.push([HEADER_FIELD.MEMBER, ["s", member]]);
    if (errorName) fields.push([HEADER_FIELD.ERROR_NAME, ["s", errorName]]);
    if (replySerial) fields.push([HEADER_FIELD.REPLY_SERIAL, ["u", replySerial]]);
    if (destination) fields.push([HEADER_FIELD.DESTINATION, ["s", destination]]);
    if (signature) fields.push([HEADER_FIELD.SIGNATURE, ["g", signature]]);

    const header = new Writer();
    header.write("y", 0x6c); // 'l': little-endian
    header.write("y", type);
    header.write("y", flags);
    header.write("y", 1); // protocol version
    header.write("u", bodyWriter.len);
    header.write("u", serial);
    header.write("a(yv)", fields);
    header.align(8);
    return Buffer.concat([header.bytes(), bodyWriter.bytes()]);
}

/** Total byte length of the message at the start of `buf`, or null if not enough has arrived to tell. */
function messageLength(buf) {
    if (buf.length < 16) {
        return null;
    }
    const le = buf[0] === 0x6c;
    const bodyLength = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
    const fieldsLength = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
    const headerEnd = 16 + fieldsLength;
    return headerEnd + ((8 - (headerEnd % 8)) % 8) + bodyLength;
}

function decodeMessage(buf) {
    if (buf[0] !== 0x6c && buf[0] !== 0x42) {
        throw new Error(`Bad D-Bus endianness byte ${buf[0]}`);
    }
    const r = new Reader(buf, 1, buf[0] === 0x6c);
    const type = r.read("y");
    const flags = r.read("y");
    r.read("y"); // protocol version
    r.read("u"); // body length, already used for framing
    const serial = r.read("u");
    const message = { type, flags, serial, body: [] };
    for (const [code, value] of r.read("a(yv)")) {
        switch (code) {
            case HEADER_FIELD.PATH: message.path = value; break;
            case HEADER_FIELD.INTERFACE: message.iface = value; break;
            case HEADER_FIELD.MEMBER: message.member = value; break;
            case HEADER_FIELD.ERROR_NAME: message.errorName = value; break;
            case HEADER_FIELD.REPLY_SERIAL: message.replySerial = value; break;
            case HEADER_FIELD.DESTINATION: message.destination = value; break;
            case HEADER_FIELD.SENDER: message.sender = value; break;
            case HEADER_FIELD.SIGNATURE: message.signature = value; break;
            default: break; // unknown fields must be ignored
        }
    }
    r.align(8);
    if (message.signature) {
        message.body = splitTypes(message.signature).map((t) => r.read(t));
    }
    return message;
}

/** The socket path of the first `unix:` entry in a bus address. Abstract sockets get Node's leading NUL. */
function socketPathFromAddress(address) {
    for (const entry of (address || "").split(";")) {
        const [transport, rest = ""] = entry.split(/:(.*)/s);
        if (transport !== "unix") {
            continue;
        }
        const params = Object.fromEntries(rest.split(",").map((kv) => kv.split(/=(.*)/s)));
        const unescape = (v) => decodeURIComponent(v);
        if (params.path) return unescape(params.path);
        if (params.abstract) return "\0" + unescape(params.abstract);
    }
    return null;
}

class SessionBus extends EventEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        this.serial = 0;
        this.pending = new Map();
        this.buffer = Buffer.alloc(0);
        this.uniqueName = null;
        this.closed = false;
    }

    /** Connects and authenticates (SASL EXTERNAL, i.e. "I am the uid on this socket"), then says Hello. */
    static connect(address = process.env.DBUS_SESSION_BUS_ADDRESS) {
        const socketPath = socketPathFromAddress(address);
        if (!socketPath) {
            return Promise.reject(new Error(`No unix socket in D-Bus address '${address}'`));
        }
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(socketPath);
            let authReply = "";
            const fail = (err) => {
                socket.destroy();
                reject(err);
            };
            socket.once("error", fail);
            socket.once("connect", () => {
                const uid = Buffer.from(String(process.getuid())).toString("hex");
                socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
            });
            const onAuthData = (chunk) => {
                authReply += chunk.toString("latin1");
                const lineEnd = authReply.indexOf("\r\n");
                if (lineEnd < 0) {
                    return;
                }
                socket.off("data", onAuthData);
                if (!authReply.startsWith("OK ")) {
                    fail(new Error(`D-Bus auth rejected: ${authReply.slice(0, lineEnd)}`));
                    return;
                }
                socket.write("BEGIN\r\n");
                socket.off("error", fail);
                const bus = new SessionBus(socket);
                bus.attach(Buffer.from(authReply.slice(lineEnd + 2), "latin1"));
                bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "Hello" })
                    .then(([name]) => {
                        bus.uniqueName = name;
                        resolve(bus);
                    })
                    .catch((err) => {
                        bus.close();
                        reject(err);
                    });
            };
            socket.on("data", onAuthData);
        });
    }

    attach(leftover) {
        this.socket.on("data", (chunk) => this.receive(chunk));
        this.socket.on("error", (err) => this.emit("error", err));
        this.socket.on("close", () => this.shutdown());
        if (leftover.length) {
            this.receive(leftover);
        }
    }

    receive(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        for (;;) {
            const length = messageLength(this.buffer);
            if (length === null || this.buffer.length < length) {
                return;
            }
            const raw = this.buffer.subarray(0, length);
            this.buffer = this.buffer.subarray(length);
            let message;
            try {
                message = decodeMessage(raw);
            } catch (err) {
                this.emit("error", err);
                continue;
            }
            this.dispatch(message);
        }
    }

    dispatch(message) {
        if (message.type === MESSAGE_TYPE.METHOD_RETURN || message.type === MESSAGE_TYPE.ERROR) {
            const waiter = this.pending.get(message.replySerial);
            if (!waiter) {
                return;
            }
            this.pending.delete(message.replySerial);
            clearTimeout(waiter.timer);
            if (message.type === MESSAGE_TYPE.ERROR) {
                const err = new Error(`${message.errorName}: ${message.body[0] ?? ""}`);
                err.dbusName = message.errorName;
                waiter.reject(err);
            } else {
                waiter.resolve(message.body);
            }
        } else if (message.type === MESSAGE_TYPE.SIGNAL) {
            this.emit("signal", message);
        } else if (message.type === MESSAGE_TYPE.METHOD_CALL && !(message.flags & FLAG_NO_REPLY_EXPECTED) && !this.closed) {
            // We serve nothing. Answering keeps a caller (e.g. a Peer.Ping) from waiting out its timeout.
            this.socket.write(encodeMessage({
                type: MESSAGE_TYPE.ERROR,
                serial: ++this.serial,
                errorName: "org.freedesktop.DBus.Error.UnknownMethod",
                replySerial: message.serial,
                destination: message.sender,
                signature: "s",
                body: [`${message.iface}.${message.member} is not served here`],
            }));
        }
    }

    /**
     * Calls a method and resolves with the reply's body (an array of its values). Rejects after `timeoutMs`: the
     * session bus sets no reply timeout of its own, so a frozen peer would otherwise leave the call pending forever.
     */
    call({ destination, path, iface, member, signature = "", body = [], timeoutMs = CALL_TIMEOUT_MS }) {
        if (this.closed) {
            return Promise.reject(new Error("D-Bus connection is closed"));
        }
        const serial = ++this.serial;
        const bytes = encodeMessage({ type: MESSAGE_TYPE.METHOD_CALL, serial, destination, path, iface, member, signature, body });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(serial);
                reject(new Error(`${iface}.${member} on ${destination} got no reply within ${timeoutMs} ms`));
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(serial, { resolve, reject, timer });
            this.socket.write(bytes);
        });
    }

    addMatch(rule) {
        return this.call({
            destination: "org.freedesktop.DBus",
            path: "/org/freedesktop/DBus",
            iface: "org.freedesktop.DBus",
            member: "AddMatch",
            signature: "s",
            body: [rule],
        });
    }

    shutdown() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error("D-Bus connection closed"));
        }
        this.pending.clear();
        this.emit("close");
    }

    close() {
        this.socket.end();
        this.socket.destroy();
        this.shutdown();
    }
}

module.exports = { SessionBus, encodeMessage, decodeMessage, messageLength, socketPathFromAddress, MESSAGE_TYPE };
