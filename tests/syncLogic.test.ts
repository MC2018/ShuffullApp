import { describe, it, expect } from "vitest";
import { playlistsToFetch, collectNewSongIds, advanceSongCursor } from "@/app/services/sync-manager/syncLogic";

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

describe("advanceSongCursor", () => {
    const d = (s: string) => new Date(s);

    it("advances to the newest version on the page (last item)", () => {
        const items = [{ version: d("2024-01-01") }, { version: d("2024-03-01") }];
        expect(advanceSongCursor(items, d("2023-01-01"))).toEqual(d("2024-03-01"));
    });

    it("leaves the cursor unchanged for an empty page", () => {
        const current = d("2024-01-01");
        expect(advanceSongCursor([], current)).toBe(current);
    });

    it("uses the trailing item even if not chronologically sorted (mirrors source)", () => {
        // The source takes the LAST item's version regardless of ordering.
        const items = [{ version: d("2024-05-01") }, { version: d("2024-02-01") }];
        expect(advanceSongCursor(items, d("2024-01-01"))).toEqual(d("2024-02-01"));
    });
});
