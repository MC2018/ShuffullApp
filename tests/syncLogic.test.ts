import { describe, it, expect } from "vitest";
import { playlistsToFetch, collectNewSongIds, FeedCursor, FeedKey, justBefore, nextFeedCursor, pageFeed, pendingSongMisses, SONG_RECONCILE_INTERVAL_MS, SONG_RECONFIRM_INTERVAL_MS, songFeedStart, songReconcileDue, songsGoneFromServer } from "@/app/services/sync-manager/syncLogic";

describe("playlistsToFetch", () => {
    const d = (s: string) => new Date(s);

    it("fetches playlists absent locally", () => {
        const accessible = [{ playlistId: "p1", version: d("2024-01-01") }];
        expect(playlistsToFetch(accessible, [])).toEqual(["p1"]);
    });

    it("fetches playlists whose server version is newer than local", () => {
        const accessible = [{ playlistId: "p1", version: d("2024-02-01") }];
        const local = [{ playlistId: "p1", version: d("2024-01-01") }];
        expect(playlistsToFetch(accessible, local)).toEqual(["p1"]);
    });

    it("skips playlists already at the same version", () => {
        const accessible = [{ playlistId: "p1", version: d("2024-01-01") }];
        const local = [{ playlistId: "p1", version: d("2024-01-01") }];
        expect(playlistsToFetch(accessible, local)).toEqual([]);
    });

    it("skips playlists whose local version is newer (no downgrade fetch)", () => {
        const accessible = [{ playlistId: "p1", version: d("2024-01-01") }];
        const local = [{ playlistId: "p1", version: d("2024-03-01") }];
        expect(playlistsToFetch(accessible, local)).toEqual([]);
    });

    it("handles a mixed set", () => {
        const accessible = [
            { playlistId: "new", version: d("2024-01-01") },
            { playlistId: "stale", version: d("2024-02-01") },
            { playlistId: "fresh", version: d("2024-01-01") },
        ];
        const local = [
            { playlistId: "stale", version: d("2024-01-01") },
            { playlistId: "fresh", version: d("2024-01-01") },
        ];
        expect(playlistsToFetch(accessible, local)).toEqual(["new", "stale"]);
    });

    it("returns empty when nothing is accessible", () => {
        expect(playlistsToFetch([], [{ playlistId: "p1", version: d("2024-01-01") }])).toEqual([]);
    });
});

describe("collectNewSongIds", () => {
    it("merges playlist and user-song ids", () => {
        const result = collectNewSongIds([["a", "b"]], ["c"], []);
        expect(result).toEqual(["a", "b", "c"]);
    });

    it("de-duplicates across and within sources (first occurrence wins)", () => {
        const result = collectNewSongIds([["a", "b"], ["b", "d"]], ["a", "e"], []);
        expect(result).toEqual(["a", "b", "d", "e"]);
    });

    it("filters out ids already held locally", () => {
        const result = collectNewSongIds([["a", "b", "c"]], ["d"], ["b", "d"]);
        expect(result).toEqual(["a", "c"]);
    });

    it("drops falsy ids", () => {
        const result = collectNewSongIds([["a", ""]], [""], []);
        expect(result).toEqual(["a"]);
    });

    it("returns empty when everything is already local", () => {
        expect(collectNewSongIds([["a"]], ["b"], ["a", "b"])).toEqual([]);
    });

    it("returns empty for empty inputs", () => {
        expect(collectNewSongIds([], [], [])).toEqual([]);
    });
});

// A server for one Version-ordered feed, as Shuffull pages it: 500 rows, endOfList once no row is left past the page.
// `keyset` is the server since Shuffull#64 (reads afterId, orders by Version then SongId); without it, the server
// before: `Version > afterDate` alone, ties in whatever order the rows were stored.
function feedServer(rows: FeedKey[], keyset: boolean) {
    const micros = (version: string) => {
        const [, second, fraction = ""] = /^(.*:\d\d)(?:\.(\d+))?Z$/.exec(version)!;
        return BigInt(Date.parse(second + "Z")) * 1000n + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
    };
    const requests: FeedCursor[] = [];
    const fetchPage = async (cursor: FeedCursor) => {
        requests.push(cursor);
        const after = micros(cursor.afterDate);
        const matching = rows
            .filter(row => micros(row.version) > after
                || (keyset && cursor.afterId != undefined && micros(row.version) == after && row.songId > cursor.afterId))
            .sort((a, b) => Number(micros(a.version) - micros(b.version)) || (keyset ? (a.songId < b.songId ? -1 : 1) : 0));
        const page = matching.slice(0, 500);
        return { items: page, keys: page, endOfList: matching.length <= 500 };
    };
    return { fetchPage, requests };
}

// Ids in an order unrelated to their sort order, the way GUIDs come.
const tiedRows = (count: number, version: string): FeedKey[] =>
    Array.from({ length: count }, (_, i) => ({ songId: `s${String((i * 7919) % count).padStart(5, "0")}`, version }));

const TIE = "2026-10-23T12:00:00.123456Z";

describe("justBefore", () => {
    it("is one microsecond earlier, keeping every digit", () => {
        expect(justBefore(TIE)).toBe("2026-10-23T12:00:00.123455Z");
    });

    it("borrows from the second when the fraction is zero", () => {
        expect(justBefore("2026-10-23T12:00:00Z")).toBe("2026-10-23T11:59:59.999999Z");
        expect(justBefore("2026-01-01T00:00:00.000000Z")).toBe("2025-12-31T23:59:59.999999Z");
    });

    it("drops a seventh digit (ticks) before stepping back, so it stays earlier", () => {
        expect(justBefore("2026-10-23T12:00:00.1234567Z")).toBe("2026-10-23T12:00:00.123455Z");
    });

    it("reads an offset, and a missing zone as UTC", () => {
        expect(justBefore("2026-10-23T14:00:00.5+02:00")).toBe("2026-10-23T12:00:00.499999Z");
        expect(justBefore("2026-10-23T12:00:00.5")).toBe("2026-10-23T12:00:00.499999Z");
    });
});

describe("nextFeedCursor", () => {
    const key = (songId: string, version: string) => ({ songId, version });

    it("pages from just before the last Version when the page holds more than one", () => {
        const keys = [key("a", "2026-10-23T11:00:00.000001Z"), key("b", TIE)];
        expect(nextFeedCursor(keys, { afterDate: "0001-01-01T00:00:00.000Z" })).toEqual({ afterDate: justBefore(TIE) });
    });

    it("pages by the exact (version, id) when the whole page shares one Version", () => {
        const keys = [key("a", TIE), key("b", TIE)];
        expect(nextFeedCursor(keys, { afterDate: justBefore(TIE) })).toEqual({ afterDate: TIE, afterId: "b" });
    });

    it("stops (null) when the next request would be the one just sent", () => {
        const keys = [key("a", TIE), key("b", TIE)];
        expect(nextFeedCursor(keys, { afterDate: TIE, afterId: "b" })).toBeNull();
        expect(nextFeedCursor([key("a", "2026-10-23T11:00:00Z"), key("b", TIE)], { afterDate: justBefore(TIE) })).toBeNull();
    });

    it("stops on an empty page that isn't the last", () => {
        expect(nextFeedCursor([], { afterDate: TIE })).toBeNull();
    });
});

describe("pageFeed", () => {
    const START = { afterDate: "0001-01-01T00:00:00.000Z" };
    const ids = (rows: FeedKey[]) => rows.map(x => x.songId).sort();

    it("pages a tie bigger than a page out once each, and ends (the 2026-10-23 hang)", async () => {
        const rows = tiedRows(1200, TIE);
        const server = feedServer(rows, true);

        const feed = await pageFeed(START, server.fetchPage);

        expect(feed.stalled).toBe(false);
        expect(feed.items).toHaveLength(1200);
        expect(ids(feed.items)).toEqual(ids(rows));
        expect(feed.last).toEqual({ songId: "s01199", version: TIE });
        expect(server.requests).toHaveLength(3);
        expect(server.requests[1]).toEqual({ afterDate: TIE, afterId: "s00499" });
    });

    it("gets every row of a tie that crosses pages among other Versions, re-asking only for tied rows", async () => {
        const before = Array.from({ length: 300 }, (_, i) =>
            ({ songId: `b${String(i).padStart(3, "0")}`, version: `2026-10-23T11:00:00.${String(i + 1).padStart(6, "0")}Z` }));
        const after = [{ songId: "z", version: "2026-10-23T13:00:00.000001Z" }];
        const rows = [...before, ...tiedRows(1100, TIE), ...after];
        const server = feedServer(rows, true);

        const feed = await pageFeed(START, server.fetchPage);

        expect(feed.stalled).toBe(false);
        expect(new Set(ids(feed.items))).toEqual(new Set(ids(rows)));
        expect(feed.last).toEqual(after[0]);
        // The first page ends 200 rows into the tie; those 200 come back once, never more.
        expect(feed.items.length).toBe(rows.length + 200);
    });

    it("loses nothing on a server without afterId when every tie fits a page", async () => {
        const rows = [
            ...tiedRows(450, TIE),
            ...tiedRows(400, "2026-10-23T12:00:01.5Z").map(x => ({ ...x, songId: `t${x.songId}` })),
            { songId: "z", version: "2026-10-23T13:00:00Z" },
        ];
        const server = feedServer(rows, false);

        const feed = await pageFeed(START, server.fetchPage);

        expect(feed.stalled).toBe(false);
        expect(new Set(ids(feed.items))).toEqual(new Set(ids(rows)));
        expect(server.requests.every(x => x.afterId == undefined)).toBe(true);
    });

    it("still ends on a server without afterId when a tie is bigger than a page", async () => {
        const server = feedServer(tiedRows(1200, TIE), false);

        const feed = await pageFeed(START, server.fetchPage);

        // That server can't page inside the tie; ending beats repeating the same page forever.
        expect(feed.stalled).toBe(false);
        expect(feed.items).toHaveLength(500);
        expect(server.requests).toHaveLength(2);
    });

    it("stops and says so when the server repeats a page", async () => {
        const page = tiedRows(500, TIE);
        const fetchPage = async () => ({ items: page, keys: page, endOfList: false });

        const feed = await pageFeed({ afterDate: TIE, afterId: page[499].songId }, fetchPage);

        expect(feed.stalled).toBe(true);
        expect(feed.items).toHaveLength(500);
    });

    it("keeps the last key from an earlier page when the final page is empty", async () => {
        const first = [{ songId: "a", version: TIE }, { songId: "b", version: "2026-10-23T13:00:00Z" }];
        const pages = [
            { items: first, keys: first, endOfList: false },
            { items: [], keys: [], endOfList: true },
        ];

        const feed = await pageFeed(START, async () => pages.shift()!);

        expect(feed.last).toEqual(first[1]);
    });
});

describe("songFeedStart", () => {
    it("is null before the first sync", () => {
        expect(songFeedStart(null, null)).toBeNull();
    });

    it("sends the stored key's id while it belongs to the stored cursor", () => {
        expect(songFeedStart(TIE, JSON.stringify({ version: TIE, songId: "s1" }))).toEqual({ afterDate: TIE, afterId: "s1" });
    });

    it("pages from the date alone for a cursor an older build wrote", () => {
        const legacy = "2026-10-23T12:00:00.123Z";
        expect(songFeedStart(legacy, null)).toEqual({ afterDate: legacy });
        expect(songFeedStart(legacy, JSON.stringify({ version: TIE, songId: "s1" }))).toEqual({ afterDate: legacy });
        expect(songFeedStart(legacy, "not json")).toEqual({ afterDate: legacy });
    });
});

describe("songsGoneFromServer", () => {
    it("a full check only remembers what it missed", () => {
        expect(songsGoneFromServer(["s1", "s2", "s3"], ["s1", "s2"], [])).toEqual({ purge: [], misses: ["s3"], implausible: 0 });
    });

    it("a confirming check purges the songs still missing and forgets the rest", () => {
        expect(songsGoneFromServer(["s2", "s3"], ["s2"], ["s2", "s3"])).toEqual({ purge: ["s3"], misses: [], implausible: 0 });
    });

    it("a full check that misses more than half the library removes and remembers nothing", () => {
        expect(songsGoneFromServer(["s1", "s2", "s3"], ["s1"], [])).toEqual({ purge: [], misses: [], implausible: 2 });
        expect(songsGoneFromServer(["s1", "s2"], [], [])).toEqual({ purge: [], misses: [], implausible: 2 });
    });

    it("exactly half missing is still believed", () => {
        expect(songsGoneFromServer(["s1", "s2"], ["s1"], [])).toEqual({ purge: [], misses: ["s2"], implausible: 0 });
    });
});

describe("pendingSongMisses", () => {
    const state = (host: string | null, userId: string, misses: unknown) => JSON.stringify({ host, userId, misses });

    it("returns the misses recorded against this server and account", () => {
        expect(pendingSongMisses(state("https://a", "u1", ["s1"]), "https://a", "u1")).toEqual(["s1"]);
    });

    it("drops misses recorded against another server or account", () => {
        expect(pendingSongMisses(state("https://a", "u1", ["s1"]), "https://b", "u1")).toEqual([]);
        expect(pendingSongMisses(state("https://a", "u1", ["s1"]), "https://a", "u2")).toEqual([]);
    });

    it("treats a missing or malformed value as no misses", () => {
        expect(pendingSongMisses(null, "https://a", "u1")).toEqual([]);
        expect(pendingSongMisses("not json", "https://a", "u1")).toEqual([]);
        expect(pendingSongMisses(JSON.stringify(["s1"]), "https://a", "u1")).toEqual([]);
        expect(pendingSongMisses(state("https://a", "u1", "s1"), "https://a", "u1")).toEqual([]);
        expect(pendingSongMisses(state("https://a", "u1", ["s1", 2]), "https://a", "u1")).toEqual(["s1"]);
    });
});

describe("songReconcileDue", () => {
    const now = 10 * SONG_RECONCILE_INTERVAL_MS;

    it("is due when there has never been a check", () => {
        expect(songReconcileDue(null, now, 0)).toBe(true);
        expect(songReconcileDue(Number("garbage"), now, 0)).toBe(true);
    });

    it("runs a full check daily", () => {
        expect(songReconcileDue(now - SONG_RECONCILE_INTERVAL_MS + 1, now, 0)).toBe(false);
        expect(songReconcileDue(now - SONG_RECONCILE_INTERVAL_MS, now, 0)).toBe(true);
    });

    it("confirms pending misses an hour later", () => {
        expect(songReconcileDue(now - SONG_RECONFIRM_INTERVAL_MS + 1, now, 3)).toBe(false);
        expect(songReconcileDue(now - SONG_RECONFIRM_INTERVAL_MS, now, 3)).toBe(true);
    });
});
