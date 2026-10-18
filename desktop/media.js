const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

/**
 * Offline media store for the desktop shell: the Electron half of the web Downloader
 * (app/services/downloader/Downloader.web.ts).
 *
 * The renderer has no filesystem (nodeIntegration is off, and the web bundle has no expo-file-system), so the
 * main process owns the files. It downloads, verifies and stores them under `<userData>/media`, and serves them
 * back to the page under the page's own origin (`app://local/__media/<kind>/<file>`) so `<audio>` and `<img>`
 * load them like any other same-origin asset. Same origin matters: the page is cross-origin isolated (COEP
 * require-corp), and a second scheme would have to earn its way past that.
 *
 * The renderer only ever names a KIND and a FILE NAME, never a path. Both are checked here, so nothing the page
 * sends can read or write outside the two media folders. Downloads are likewise built from the host plus
 * `/<kind>/<file>`, the same two server routes the native Downloader uses, rather than taking any URL.
 */

const MEDIA_ROUTE = "/__media/";

/** The two folders, matching the native layout (`music/`, `albumart/`) and the server's routes of the same name. */
const MEDIA_KINDS = new Set(["music", "albumart"]);

// `<fileHash><fileExtension>` (Downloader.generateSongFileName). A hash is hex; the extension is short and
// alphanumeric. Anything else - a slash, `..`, a NUL, an empty stem - is refused rather than sanitised.
const FILE_NAME = /^[0-9a-fA-F]{8,128}\.[A-Za-z0-9]{1,8}$/;

const CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".webm": "audio/webm",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

function isMediaKind(kind) {
    return typeof kind === "string" && MEDIA_KINDS.has(kind);
}

function isMediaFileName(fileName) {
    return typeof fileName === "string" && FILE_NAME.test(fileName);
}

/** Absolute path of a stored file, or undefined when either part is not one we accept. */
function mediaFilePath(root, kind, fileName) {
    if (!isMediaKind(kind) || !isMediaFileName(fileName)) {
        return undefined;
    }
    return path.join(root, kind, fileName);
}

/** `/__media/music/abc.mp3` -> { kind, fileName }, or undefined for any other path. */
function parseMediaPath(pathname) {
    if (typeof pathname !== "string" || !pathname.startsWith(MEDIA_ROUTE)) {
        return undefined;
    }
    const parts = pathname.slice(MEDIA_ROUTE.length).split("/");
    if (parts.length !== 2 || !isMediaKind(parts[0]) || !isMediaFileName(parts[1])) {
        return undefined;
    }
    return { kind: parts[0], fileName: parts[1] };
}

function contentTypeFor(fileName) {
    return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Parses a single-range `Range` header against a file of `size` bytes. Returns:
 *   undefined          - no usable Range header: serve the whole file (200)
 *   { start, end }     - inclusive byte range to serve (206)
 *   "unsatisfiable"    - the range lies outside the file (416)
 *
 * `<audio>` seeks by asking for `bytes=N-`; without a 206 answer Chromium cannot seek a local file at all, so
 * this is what makes the scrubber work offline. Multi-range requests are answered with the whole file, which
 * the spec allows and no media element sends.
 */
function parseRange(header, size) {
    if (typeof header !== "string") {
        return undefined;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (match[1] === "" && match[2] === "")) {
        return undefined;
    }
    let start;
    let end;
    if (match[1] === "") {
        // Suffix range: the last N bytes.
        const suffix = Number(match[2]);
        if (suffix === 0) {
            return "unsatisfiable";
        }
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (start >= size || start > end) {
        return "unsatisfiable";
    }
    return { start, end };
}

/** Serves a stored file for the `app://` handler, honouring Range. */
async function serveMedia(root, pathname, rangeHeader) {
    const parsed = parseMediaPath(pathname);
    if (!parsed) {
        return new Response("Not found", { status: 404 });
    }
    const filePath = mediaFilePath(root, parsed.kind, parsed.fileName);
    let stat;
    try {
        stat = await fsp.stat(filePath);
    } catch {
        return new Response("Not found", { status: 404 });
    }

    const headers = { "Content-Type": contentTypeFor(parsed.fileName), "Accept-Ranges": "bytes" };
    const range = parseRange(rangeHeader, stat.size);
    if (range === "unsatisfiable") {
        return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
    }
    if (range === undefined) {
        const body = Readable.toWeb(fs.createReadStream(filePath));
        return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(stat.size) } });
    }
    const body = Readable.toWeb(fs.createReadStream(filePath, { start: range.start, end: range.end }));
    return new Response(body, {
        status: 206,
        headers: {
            ...headers,
            "Content-Length": String(range.end - range.start + 1),
            "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
        },
    });
}

/**
 * Same rule as the native `verifyFileIntegrity`: the file name's stem is a prefix of the SHA-256 of its bytes.
 * A 404 page, a proxy error or a truncated body fails it, so none of those can land in the store as a song.
 */
function hashMatchesFileName(sha256Hex, fileName) {
    const stem = fileName.split(".")[0].toLowerCase();
    return stem.length > 0 && sha256Hex.toLowerCase().startsWith(stem);
}

function isHttpUrl(value) {
    try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * Downloads `<host>/<kind>/<fileName>` into the store. The body goes to a temp file first and is only renamed
 * into place once it is complete (and, for music, verified), so a crash or a failed download never leaves a
 * half file where `exists` would report it as saved. Rename within one filesystem is atomic.
 *
 * `onProgress(received, total)` fires as bytes arrive; total is 0 when the server sends no Content-Length.
 * Resolves `{ ok: true }` or `{ ok: false, error }` - never throws, so one bad song can't take down the IPC call.
 */
async function downloadMedia({ root, fetchImpl, host, kind, fileName, verify, onProgress }) {
    const finalPath = mediaFilePath(root, kind, fileName);
    if (!finalPath) {
        return { ok: false, error: `refused: ${kind}/${fileName}` };
    }
    if (!isHttpUrl(host)) {
        return { ok: false, error: "refused: host is not http(s)" };
    }

    const tempPath = path.join(root, "temp", `${fileName}.${process.pid}.${Date.now()}.part`);
    try {
        await fsp.mkdir(path.dirname(tempPath), { recursive: true });
        await fsp.mkdir(path.dirname(finalPath), { recursive: true });

        const url = new URL(`${kind}/${fileName}`, host.endsWith("/") ? host : `${host}/`).toString();
        const response = await fetchImpl(url);
        if (!response.ok || response.body == null) {
            return { ok: false, error: `HTTP ${response.status} for ${kind}/${fileName}` };
        }

        const total = Number(response.headers.get("content-length")) || 0;
        const hash = crypto.createHash("sha256");
        let received = 0;
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                hash.update(chunk);
                onProgress?.(received, total);
                callback(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(tempPath));

        if (verify && !hashMatchesFileName(hash.digest("hex"), fileName)) {
            return { ok: false, error: `integrity check failed for ${kind}/${fileName}` };
        }

        await fsp.rename(tempPath, finalPath);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
    } finally {
        // Gone already after a successful rename; otherwise this is the cleanup.
        await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
}

async function mediaExists(root, kind, fileName) {
    const filePath = mediaFilePath(root, kind, fileName);
    if (!filePath) {
        return false;
    }
    try {
        return (await fsp.stat(filePath)).isFile();
    } catch {
        return false;
    }
}

/** Idempotent: a missing file is a no-op, matching the native `deleteAsync(..., { idempotent: true })`. */
async function deleteMedia(root, kind, fileName) {
    const filePath = mediaFilePath(root, kind, fileName);
    if (filePath) {
        await fsp.rm(filePath, { force: true });
    }
}

/** Leftover `.part` files are from a download the app was closed during; none of them can still be in flight. */
async function clearTemp(root) {
    await fsp.rm(path.join(root, "temp"), { recursive: true, force: true });
}

module.exports = {
    MEDIA_ROUTE,
    isMediaKind,
    isMediaFileName,
    mediaFilePath,
    parseMediaPath,
    parseRange,
    contentTypeFor,
    hashMatchesFileName,
    serveMedia,
    downloadMedia,
    mediaExists,
    deleteMedia,
    clearTemp,
};
