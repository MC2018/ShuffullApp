import { describe, it, expect } from "vitest";
import { decideSongDownload, isUsableArtDownload, MAX_HASH_MISMATCHES } from "@/app/tools/downloadFailure";

// The regression these guard (ShuffullApp#86): downloadAsync resolves on a 404, the empty body failed the hash
// check, and the row stayed at the head of the queue - so one song purged server-side was retried forever and
// nothing behind it (4,236 queued on the phone, 573 of them gone server-side) ever downloaded.
describe("decideSongDownload", () => {
    it("drops a song the server no longer has instead of retrying it forever", () => {
        expect(decideSongDownload({ status: 404 }, 0)).toEqual({ action: "drop", reason: "server returned 404" });
        expect(decideSongDownload({ status: 410 }, 0).action).toBe("drop");
        expect(decideSongDownload({ status: 403 }, 0).action).toBe("drop");
    });

    it("drops on the status alone, without needing the error body hashed", () => {
        expect(decideSongDownload({ status: 404, hashMatches: undefined }, 0).action).toBe("drop");
        // Even a body that somehow hashes right is an error response, not the song.
        expect(decideSongDownload({ status: 404, hashMatches: true }, 0).action).toBe("drop");
    });

    // A Cloudflare tunnel outage answers 530 for every song; dropping on it would empty the whole queue.
    it("keeps the row for a server or tunnel that is having a moment", () => {
        for (const status of [500, 502, 503, 530, 408, 429]) {
            expect(decideSongDownload({ status }, 0).action).toBe("retry");
        }
        // However many times it has happened: outages don't use up a budget.
        expect(decideSongDownload({ status: 530 }, 99).action).toBe("retry");
    });

    it("retries when the download produced no result (cancelled or interrupted)", () => {
        expect(decideSongDownload(undefined, 0).action).toBe("retry");
        expect(decideSongDownload(undefined, 99).action).toBe("retry");
    });

    it("retries a hash mismatch a few times, then stops letting it block the queue", () => {
        for (let seen = 0; seen < MAX_HASH_MISMATCHES - 1; seen++) {
            expect(decideSongDownload({ status: 200, hashMatches: false }, seen).action).toBe("retry");
        }
        const last = decideSongDownload({ status: 200, hashMatches: false }, MAX_HASH_MISMATCHES - 1);
        expect(last).toEqual({ action: "drop", reason: `file hash did not match after ${MAX_HASH_MISMATCHES} attempts` });
    });

    it("never accepts an unverified file", () => {
        expect(decideSongDownload({ status: 200 }, 0).action).not.toBe("accept");
    });

    it("accepts a 2xx whose hash matches", () => {
        expect(decideSongDownload({ status: 200, hashMatches: true }, 0)).toEqual({ action: "accept" });
        // Earlier mismatches don't count against a download that came through intact.
        expect(decideSongDownload({ status: 200, hashMatches: true }, MAX_HASH_MISMATCHES - 1)).toEqual({ action: "accept" });
    });
});

// Album art used to block the song too: a missing .jpg returned "failed" forever even after the audio landed,
// and a 404 body was saved as the art. Art is best-effort now; only a 2xx is kept.
describe("isUsableArtDownload", () => {
    it("keeps only a successful response", () => {
        expect(isUsableArtDownload({ status: 200 })).toBe(true);
        expect(isUsableArtDownload({ status: 404 })).toBe(false);
        expect(isUsableArtDownload({ status: 500 })).toBe(false);
        expect(isUsableArtDownload({ status: 304 })).toBe(false);
        expect(isUsableArtDownload(undefined)).toBe(false);
    });
});
