import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { localMediaUri, MEDIA_ROUTE, parseLocalMediaUri } from "@/app/tools/desktopMedia";

// desktop/media.js is the Electron main process's CommonJS module; it has no Electron imports, so it runs here.
const media = createRequire(import.meta.url)("../desktop/media.js");

const HASH = "0123456789abcdef0123456789abcdef";

describe("file names and paths", () => {
    it("accepts only <hex hash>.<ext>", () => {
        expect(media.isMediaFileName(`${HASH}.mp3`)).toBe(true);
        expect(media.isMediaFileName(`${HASH}.jpg`)).toBe(true);
        for (const bad of ["../etc.mp3", `${HASH}/x.mp3`, `${HASH}`, ".mp3", `${HASH}.mp3/..`, `..\\${HASH}.mp3`, `${HASH}.mp3\0`, 42, undefined]) {
            expect(media.isMediaFileName(bad)).toBe(false);
        }
    });

    it("refuses unknown kinds rather than mapping them to a path", () => {
        expect(media.mediaFilePath("/root", "music", `${HASH}.mp3`)).toBe(path.join("/root", "music", `${HASH}.mp3`));
        expect(media.mediaFilePath("/root", "temp", `${HASH}.mp3`)).toBeUndefined();
        expect(media.mediaFilePath("/root", "..", `${HASH}.mp3`)).toBeUndefined();
    });

    it("parses only the media route", () => {
        expect(media.parseMediaPath(`/__media/music/${HASH}.mp3`)).toEqual({ kind: "music", fileName: `${HASH}.mp3` });
        expect(media.parseMediaPath(`/__media/albumart/${HASH}.jpg`)).toEqual({ kind: "albumart", fileName: `${HASH}.jpg` });
        expect(media.parseMediaPath(`/__media/music/../../x/${HASH}.mp3`)).toBeUndefined();
        expect(media.parseMediaPath(`/__media/temp/${HASH}.mp3`)).toBeUndefined();
        expect(media.parseMediaPath("/index.html")).toBeUndefined();
    });

    it("renderer and main agree on the route", () => {
        expect(MEDIA_ROUTE).toBe(media.MEDIA_ROUTE);
        const uri = localMediaUri("app://local", "music", `${HASH}.mp3`);
        expect(uri).toBe(`app://local/__media/music/${HASH}.mp3`);
        expect(media.parseMediaPath(new URL(uri).pathname)).toEqual({ kind: "music", fileName: `${HASH}.mp3` });
    });
});

describe("parseLocalMediaUri", () => {
    it("round-trips localMediaUri", () => {
        expect(parseLocalMediaUri(localMediaUri("app://local", "albumart", `${HASH}.jpg`))).toEqual({ kind: "albumart", fileName: `${HASH}.jpg` });
    });

    it("ignores server URLs and the browser build's empty URI", () => {
        expect(parseLocalMediaUri(`https://shuffull-api.clausius.app/music/${HASH}.mp3`)).toBeUndefined();
        expect(parseLocalMediaUri("")).toBeUndefined();
        expect(parseLocalMediaUri(`app://local/__media/other/${HASH}.mp3`)).toBeUndefined();
    });
});

describe("parseRange", () => {
    it("serves the whole file without a usable header", () => {
        expect(media.parseRange(undefined, 100)).toBeUndefined();
        expect(media.parseRange(null, 100)).toBeUndefined();
        expect(media.parseRange("bytes=-", 100)).toBeUndefined();
        expect(media.parseRange("items=0-1", 100)).toBeUndefined();
        expect(media.parseRange("bytes=0-1,5-6", 100)).toBeUndefined();
    });

    it("handles open, closed and suffix ranges", () => {
        expect(media.parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
        expect(media.parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
        expect(media.parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
        expect(media.parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
        expect(media.parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    });

    it("reports ranges outside the file", () => {
        expect(media.parseRange("bytes=100-", 100)).toBe("unsatisfiable");
        expect(media.parseRange("bytes=20-10", 100)).toBe("unsatisfiable");
        expect(media.parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    });
});

describe("downloadMedia", () => {
    const body = new TextEncoder().encode("pretend this is an mp3");
    const goodName = `${createHash("sha256").update(body).digest("hex").slice(0, 32)}.mp3`;
    const fakeFetch = (status: number, bytes: Uint8Array<ArrayBuffer>) => async (url: string) => {
        fakeFetch.lastUrl = url;
        return new Response(status === 200 ? bytes : "nope", { status, headers: { "content-length": String(bytes.length) } });
    };
    fakeFetch.lastUrl = "";

    it("stores a verified file under its kind and builds the URL from host + kind + name", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "shuffull-media-"));
        const progress: number[] = [];
        const result = await media.downloadMedia({
            root, fetchImpl: fakeFetch(200, body), host: "https://example.test/api", kind: "music", fileName: goodName, verify: true,
            onProgress: (received: number) => progress.push(received),
        });
        expect(result).toEqual({ ok: true });
        expect(fakeFetch.lastUrl).toBe(`https://example.test/api/music/${goodName}`);
        expect(readFileSync(path.join(root, "music", goodName))).toEqual(Buffer.from(body));
        expect(progress.at(-1)).toBe(body.length);
        expect(readdirSync(path.join(root, "temp"))).toEqual([]);
        expect(await media.mediaExists(root, "music", goodName)).toBe(true);

        await media.deleteMedia(root, "music", goodName);
        await media.deleteMedia(root, "music", goodName); // idempotent
        expect(await media.mediaExists(root, "music", goodName)).toBe(false);
    });

    it("leaves nothing behind when the bytes don't match the name", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "shuffull-media-"));
        const result = await media.downloadMedia({ root, fetchImpl: fakeFetch(200, body), host: "https://example.test", kind: "music", fileName: `${HASH}.mp3`, verify: true });
        expect(result.ok).toBe(false);
        expect(existsSync(path.join(root, "music", `${HASH}.mp3`))).toBe(false);
        expect(readdirSync(path.join(root, "temp"))).toEqual([]);
    });

    it("fails on an HTTP error instead of storing the error page", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "shuffull-media-"));
        const result = await media.downloadMedia({ root, fetchImpl: fakeFetch(404, body), host: "https://example.test", kind: "albumart", fileName: `${HASH}.jpg`, verify: false });
        expect(result).toEqual({ ok: false, error: `HTTP 404 for albumart/${HASH}.jpg` });
        expect(existsSync(path.join(root, "albumart", `${HASH}.jpg`))).toBe(false);
    });

    it("refuses bad names and non-http hosts before fetching anything", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "shuffull-media-"));
        const fetchImpl = async () => { throw new Error("should not fetch"); };
        expect((await media.downloadMedia({ root, fetchImpl, host: "https://example.test", kind: "music", fileName: "../../x.mp3" })).ok).toBe(false);
        expect((await media.downloadMedia({ root, fetchImpl, host: "file:///etc", kind: "music", fileName: goodName })).ok).toBe(false);
    });
});

describe("serveMedia", () => {
    it("answers Range requests with 206 and the right slice", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "shuffull-media-"));
        const bytes = new TextEncoder().encode("0123456789");
        const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.mp3`;
        await media.downloadMedia({ root, fetchImpl: async () => new Response(bytes), host: "https://example.test", kind: "music", fileName: name, verify: true });

        const whole = await media.serveMedia(root, `/__media/music/${name}`, null);
        expect(whole.status).toBe(200);
        expect(whole.headers.get("content-type")).toBe("audio/mpeg");
        expect(whole.headers.get("accept-ranges")).toBe("bytes");
        expect(await whole.text()).toBe("0123456789");

        const part = await media.serveMedia(root, `/__media/music/${name}`, "bytes=4-");
        expect(part.status).toBe(206);
        expect(part.headers.get("content-range")).toBe("bytes 4-9/10");
        expect(await part.text()).toBe("456789");

        expect((await media.serveMedia(root, `/__media/music/${name}`, "bytes=50-")).status).toBe(416);
        expect((await media.serveMedia(root, `/__media/music/${HASH}.mp3`, null)).status).toBe(404);
        expect((await media.serveMedia(root, "/__media/music/../secret", null)).status).toBe(404);
    });
});
