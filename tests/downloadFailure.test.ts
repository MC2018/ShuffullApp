import { describe, it, expect } from "vitest";
import {
    decideArtDownload,
    decideSongDownload,
    MAX_CONSECUTIVE_DROPS,
    MAX_HASH_MISMATCHES,
    SongDownloadHistory,
} from "@/app/tools/downloadFailure";

const fresh: SongDownloadHistory = { hashMismatches: 0, consecutiveDrops: 0 };
const history = (patch: Partial<SongDownloadHistory>): SongDownloadHistory => ({ ...fresh, ...patch });

// The regression these guard (ShuffullApp#86): downloadAsync resolves on a 404, the empty body failed the hash
// check, and the row stayed at the head of the queue - so one song purged server-side was retried forever and
// nothing behind it (4,236 queued on the phone, 573 of them gone server-side) ever downloaded.
describe("decideSongDownload", () => {
    it("drops a song the server no longer has instead of retrying it forever", () => {
        expect(decideSongDownload({ status: 404 }, fresh)).toEqual({ action: "drop", reason: "server returned 404" });
        expect(decideSongDownload({ status: 410 }, fresh).action).toBe("drop");
        expect(decideSongDownload({ status: 403 }, fresh).action).toBe("drop");
    });

    it("drops on the status alone, without needing the error body hashed", () => {
        expect(decideSongDownload({ status: 404, hashMatches: undefined }, fresh).action).toBe("drop");
        // Even a body that somehow hashes right is an error response, not the song.
        expect(decideSongDownload({ status: 404, hashMatches: true }, fresh).action).toBe("drop");
    });

    // A Cloudflare tunnel outage answers 530 for every song; dropping on it would empty the whole queue.
    it("keeps the row for a server or tunnel that is having a moment", () => {
        for (const status of [500, 502, 503, 530, 408, 429]) {
            expect(decideSongDownload({ status }, fresh).action).toBe("retry");
        }
        // However many times it has happened: outages don't use up a budget.
        expect(decideSongDownload({ status: 530 }, history({ consecutiveDrops: 99 })).action).toBe("retry");
    });

    it("retries when the download produced no result (cancelled or interrupted)", () => {
        expect(decideSongDownload(undefined, fresh).action).toBe("retry");
        expect(decideSongDownload(undefined, history({ consecutiveDrops: 99 })).action).toBe("retry");
    });

    it("retries a hash mismatch a few times, counting each one, then stops letting it block the queue", () => {
        for (let seen = 0; seen < MAX_HASH_MISMATCHES - 1; seen++) {
            expect(decideSongDownload({ status: 200, hashMatches: false }, history({ hashMismatches: seen }))).toEqual({
                action: "retry",
                reason: `file hash did not match (attempt ${seen + 1} of ${MAX_HASH_MISMATCHES})`,
                hashMismatches: seen + 1,
            });
        }
        const last = decideSongDownload({ status: 200, hashMatches: false }, history({ hashMismatches: MAX_HASH_MISMATCHES - 1 }));
        expect(last).toEqual({ action: "drop", reason: `file hash did not match after ${MAX_HASH_MISMATCHES} attempts` });
    });

    it("does not count a retry that never got as far as the hash as a mismatch", () => {
        expect(decideSongDownload({ status: 503 }, history({ hashMismatches: 1 }))).toMatchObject({ action: "retry", hashMismatches: 1 });
        expect(decideSongDownload(undefined, history({ hashMismatches: 1 }))).toMatchObject({ action: "retry", hashMismatches: 1 });
    });

    it("never accepts an unverified file", () => {
        expect(decideSongDownload({ status: 200 }, fresh).action).not.toBe("accept");
    });

    it("accepts a 2xx whose hash matches", () => {
        expect(decideSongDownload({ status: 200, hashMatches: true }, fresh)).toEqual({ action: "accept" });
        // Earlier mismatches don't count against a download that came through intact.
        expect(decideSongDownload({ status: 200, hashMatches: true }, history({ hashMismatches: MAX_HASH_MISMATCHES - 1 }))).toEqual({ action: "accept" });
    });

    // A failure that answers EVERY song alike - the API's music volume not mounted serves an empty folder, so all
    // 404; a Cloudflare rule answers 403 - must not delete the whole queue, which exists only on the device.
    describe("too many drops in a row", () => {
        it("drops up to the limit", () => {
            for (let drops = 0; drops < MAX_CONSECUTIVE_DROPS; drops++) {
                expect(decideSongDownload({ status: 404 }, history({ consecutiveDrops: drops })).action).toBe("drop");
            }
        });

        it("then defers instead of dropping, so the row is kept", () => {
            const atLimit = history({ consecutiveDrops: MAX_CONSECUTIVE_DROPS });
            expect(decideSongDownload({ status: 404 }, atLimit).action).toBe("defer");
            expect(decideSongDownload({ status: 403 }, atLimit).action).toBe("defer");
            const mismatch = decideSongDownload(
                { status: 200, hashMatches: false },
                history({ consecutiveDrops: MAX_CONSECUTIVE_DROPS, hashMismatches: MAX_HASH_MISMATCHES - 1 }),
            );
            expect(mismatch.action).toBe("defer");
        });

        it("still downloads and retries normally while on a run", () => {
            const atLimit = history({ consecutiveDrops: MAX_CONSECUTIVE_DROPS });
            expect(decideSongDownload({ status: 200, hashMatches: true }, atLimit)).toEqual({ action: "accept" });
            expect(decideSongDownload({ status: 530 }, atLimit).action).toBe("retry");
        });
    });
});

// Album art used to block the song: a missing .jpg returned "failed" forever even after the audio landed, and a
// 404 body was saved as the art. But nothing fetches art after the fact, and the server-URL fallback only works
// online, so a transient art failure must retry rather than save the song without art for good.
describe("decideArtDownload", () => {
    it("keeps only a successful response", () => {
        expect(decideArtDownload({ status: 200 })).toBe("keep");
    });

    it("saves the song without art when the server has none", () => {
        expect(decideArtDownload({ status: 404 })).toBe("without");
        expect(decideArtDownload({ status: 410 })).toBe("without");
    });

    it("retries the song on a failure that may clear up", () => {
        for (const status of [500, 503, 530, 408, 429]) {
            expect(decideArtDownload({ status })).toBe("retry");
        }
        expect(decideArtDownload(undefined)).toBe("retry");
    });

    it("never keeps a non-2xx body as the art", () => {
        expect(decideArtDownload({ status: 304 })).not.toBe("keep");
        expect(decideArtDownload({ status: 404 })).not.toBe("keep");
    });
});
