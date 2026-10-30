import { describe, expect, it } from "vitest";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";
import type { GenreJam } from "@/app/services/db/models";

/**
 * When a song finishes, `skip()` picks the next one through the CURRENT song filters. So the filters a screen
 * hands to `playSpecificSong` are what keeps playback going, and an empty-looking scope silently changes
 * behaviour rather than erroring: playback either wanders out of the list or (before the whole-library
 * fallback) stopped dead after one song.
 *
 * These pin the scope each list screen builds.
 */
describe("playback scopes", () => {
    it("only a genre jam's scope says so, for the listen log, and filters saved before the flag read as not one", () => {
        const jam = SongFilters.fromGenreJam({
            genreJamId: "jam-1", name: "Jam", whitelists: { genreIds: ["g1"] }, blacklists: {}, heavinessMin: null, heavinessMax: null,
        } as unknown as GenreJam, false);
        expect(jam.genreJam).toBe(true);

        jam.setSoleFilter(SongFilterType.Playlist, ["playlist-1"]);
        expect(jam.genreJam).toBe(false);

        // As getSongFilters reads them back: the stored JSON on the class prototype, with no field initialisers run.
        const legacy = Object.setPrototypeOf(JSON.parse(JSON.stringify({ localOnly: false, unheardOnly: false })), SongFilters.prototype) as SongFilters;
        expect(legacy.genreJam === true).toBe(false);
    });

    it("a playlist scope filters to that playlist and nothing else", () => {
        const scope = new SongFilters();
        scope.setSoleFilter(SongFilterType.Playlist, ["playlist-1"]);

        expect(scope.hasAnyFilter()).toBe(true);
        expect(scope.whitelists.playlistIds).toEqual(["playlist-1"]);
        expect(scope.whitelists.artistIds).toEqual([]);
        expect(scope.hasAnyBlacklistFilter()).toBe(false);
    });

    it("an artist scope filters to that artist", () => {
        const scope = new SongFilters();
        scope.setSoleFilter(SongFilterType.Artist, ["artist-1"]);

        expect(scope.hasAnyFilter()).toBe(true);
        expect(scope.whitelists.artistIds).toEqual(["artist-1"]);
        expect(scope.whitelists.playlistIds).toEqual([]);
    });

    it("the downloads scope is local-only", () => {
        const scope = new SongFilters();
        scope.localOnly = true;

        // localOnly alone must count as a filter, or the downloads list would fall through to
        // whole-library shuffle and start streaming songs that aren't on disk.
        expect(scope.hasAnyFilter()).toBe(true);
        expect(scope.hasAnyWhitelistFilter()).toBe(false);
    });

    it("a bare scope carries no filter, which now means whole-library shuffle rather than stopping", () => {
        expect(new SongFilters().hasAnyFilter()).toBe(false);
    });

    it("setSoleFilter REPLACES any previous scope instead of accumulating", () => {
        // Scopes are reused across screens via getSongFilters(); leaking the previous screen's filter would
        // narrow the pool to songs matching both, which can easily be empty.
        const scope = new SongFilters();
        scope.setSoleFilter(SongFilterType.Artist, ["artist-1"]);
        scope.setSoleFilter(SongFilterType.Playlist, ["playlist-1"]);

        expect(scope.whitelists.artistIds).toEqual([]);
        expect(scope.whitelists.playlistIds).toEqual(["playlist-1"]);
    });
});
