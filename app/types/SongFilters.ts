import { GenreJam } from "../services/db/models";
import { WhitelistSetting } from "../services/db/types";

function emptyWhitelist(): WhitelistSetting {
    return { artistIds: [], playlistIds: [], genreIds: [], timePeriodIds: [], languageIds: [], moodIds: [] };
}

// Normalizes a possibly-partial WhitelistSetting (e.g. a jam saved before moodIds existed) so every id
// array is present.
function normalizeWhitelist(w: WhitelistSetting): WhitelistSetting {
    return {
        artistIds: w.artistIds ?? [],
        playlistIds: w.playlistIds ?? [],
        genreIds: w.genreIds ?? [],
        timePeriodIds: w.timePeriodIds ?? [],
        languageIds: w.languageIds ?? [],
        moodIds: w.moodIds ?? [],
    };
}

function anySet(w: WhitelistSetting): boolean {
    return w.playlistIds.length > 0
        || w.artistIds.length > 0
        || w.genreIds.length > 0
        || w.timePeriodIds.length > 0
        || w.languageIds.length > 0
        || (w.moodIds?.length ?? 0) > 0;
}

export class SongFilters {
    localOnly = false;
    whitelists: WhitelistSetting = emptyWhitelist();
    blacklists: WhitelistSetting = emptyWhitelist();
    // Energy band [energyMin, energyMax] (1-10); null = no bound. Songs with unknown energy are still included.
    energyMin: number | null = null;
    energyMax: number | null = null;

    public static fromGenreJam(genreJam: GenreJam, localOnly: boolean): SongFilters {
        const songFilters = new SongFilters();

        songFilters.localOnly = localOnly;
        songFilters.whitelists = normalizeWhitelist(genreJam.whitelists);
        songFilters.blacklists = normalizeWhitelist(genreJam.blacklists);
        songFilters.energyMin = genreJam.energyMin ?? null;
        songFilters.energyMax = genreJam.energyMax ?? null;

        return songFilters;
    }

    public setSoleFilter(type: SongFilterType, ids: string[]) {
        this.whitelists = emptyWhitelist();
        this.blacklists = emptyWhitelist();

        switch (type) {
            case SongFilterType.Artist:
                this.whitelists.artistIds = ids;
                break;
            case SongFilterType.Playlist:
                this.whitelists.playlistIds = ids;
                break;
            case SongFilterType.Genre:
                this.whitelists.genreIds = ids;
                break;
            case SongFilterType.Language:
                this.whitelists.languageIds = ids;
                break;
            case SongFilterType.TimePeriod:
                this.whitelists.timePeriodIds = ids;
                break;
            case SongFilterType.Mood:
                this.whitelists.moodIds = ids;
                break;
        }
    }

    hasAnyFilter(): boolean {
        return this.localOnly || this.hasAnyWhitelistFilter() || this.hasAnyBlacklistFilter() || this.energyMin != null || this.energyMax != null;
    }

    hasAnyWhitelistFilter(): boolean {
        return anySet(this.whitelists);
    }

    hasAnyBlacklistFilter(): boolean {
        return anySet(this.blacklists);
    }
};

export enum SongFilterType {
    Playlist,
    Artist,
    Genre,
    TimePeriod,
    Language,
    Mood
};
