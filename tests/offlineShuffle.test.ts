import { describe, expect, it } from "vitest";
import { isShuffleEligible, shufflePool, ShuffleSource } from "@/app/tools/offlineShuffle";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";

/**
 * While the server can't be reached, a streamed pick stalls on "Waiting for connection", so the shuffle sticks to
 * downloaded songs (ShuffullApp#24). The localOnly SQL itself is pinned in filteredSongPool.test.ts; these pin which
 * filters the shuffle asks for, and when.
 */
const inScope = ["downloaded-1", "downloaded-2", "streamed-1", "streamed-2"];
const downloaded = new Set(["downloaded-1", "downloaded-2"]);

function playlistScope(): SongFilters {
    const filters = new SongFilters();
    filters.setSoleFilter(SongFilterType.Playlist, ["playlist-1"]);
    return filters;
}

function source(overrides: Partial<ShuffleSource> & { songs?: string[]; prefetched?: string[] } = {}): ShuffleSource & { asked: SongFilters[] } {
    const songs = overrides.songs ?? inScope;
    const asked: SongFilters[] = [];
    return {
        filters: playlistScope(),
        serverUnreachable: false,
        query: async (filters) => {
            asked.push(filters);
            return songs.filter(x => !filters.localOnly || downloaded.has(x)).map(songId => ({ songId, lastPlayed: null }));
        },
        songExists: async (songId) => songs.includes(songId) || songId === "elsewhere-in-library",
        isPrefetched: async (songId) => (overrides.prefetched ?? []).includes(songId),
        asked,
        ...overrides,
    };
}

const ids = (pool: { songId: string }[] | undefined) => pool?.map(x => x.songId);

describe("offline shuffle (ShuffullApp#24)", () => {
    it("with the server reachable, the pool is the whole scope, streamed songs included", async () => {
        expect(ids(await shufflePool(source()))).toEqual(inScope);
    });

    it("with the server unreachable, the pool narrows to the scope's downloaded songs, without touching the saved scope", async () => {
        const offline = source({ serverUnreachable: true });

        expect(ids(await shufflePool(offline))).toEqual(["downloaded-1", "downloaded-2"]);
        expect(offline.filters.localOnly).toBe(false);
    });

    it("with nothing in scope downloaded, it falls back to the whole scope rather than an empty pool", async () => {
        // An empty pool would fall through to whole-library shuffle; the scope at least keeps playing the right songs
        // once the connection is back.
        const offline = source({ serverUnreachable: true, songs: ["streamed-1", "streamed-2"] });

        expect(ids(await shufflePool(offline))).toEqual(["streamed-1", "streamed-2"]);
    });

    it("a scope that is already downloads-only isn't queried twice", async () => {
        const filters = new SongFilters();
        filters.localOnly = true;
        const offline = source({ serverUnreachable: true, filters });

        expect(ids(await shufflePool(offline))).toEqual(["downloaded-1", "downloaded-2"]);
        expect(offline.asked).toHaveLength(1);
    });

    it("a bare scope offline narrows to every downloaded song instead of the whole library", async () => {
        const offline = source({ serverUnreachable: true, filters: new SongFilters() });

        expect(ids(await shufflePool(offline))).toEqual(["downloaded-1", "downloaded-2"]);
        expect(await shufflePool(source({ filters: new SongFilters() }))).toBeUndefined();
    });

    describe("whether a song lined up ahead may still play", () => {
        it("offline, a downloaded song in scope stays and a streamed one gives way", async () => {
            const offline = source({ serverUnreachable: true });

            expect(await isShuffleEligible("downloaded-1", offline)).toBe(true);
            expect(await isShuffleEligible("streamed-1", offline)).toBe(false);
        });

        it("offline, a streamed song already in the prefetch cache stays, if it is still in scope", async () => {
            const offline = source({ serverUnreachable: true, prefetched: ["streamed-1", "elsewhere-in-library"] });

            expect(await isShuffleEligible("streamed-1", offline)).toBe(true);
            expect(await isShuffleEligible("elsewhere-in-library", offline)).toBe(false);
        });

        it("online, any song in scope stays, and with no scope any song in the library", async () => {
            expect(await isShuffleEligible("streamed-1", source())).toBe(true);
            expect(await isShuffleEligible("elsewhere-in-library", source())).toBe(false);
            expect(await isShuffleEligible("elsewhere-in-library", source({ filters: new SongFilters() }))).toBe(true);
        });

        it("offline with nothing in scope downloaded, eligibility is the same as online", async () => {
            const offline = source({ serverUnreachable: true, songs: ["streamed-1"] });

            expect(await isShuffleEligible("streamed-1", offline)).toBe(true);
        });
    });
});
