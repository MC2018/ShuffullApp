import { GenreJam } from "../services/db/models";
import { WhitelistSetting } from "../services/db/types";

function emptyWhitelist(): WhitelistSetting {
    return { artistIds: [], playlistIds: [], genreIds: [], timePeriodIds: [], languageIds: [], moodIds: [], themeIds: [] };
}

// Normalizes a possibly-partial WhitelistSetting (e.g. a jam saved before moodIds/themeIds existed) so every
// id array is present.
function normalizeWhitelist(w: WhitelistSetting): WhitelistSetting {
    return {
        artistIds: w.artistIds ?? [],
        playlistIds: w.playlistIds ?? [],
        genreIds: w.genreIds ?? [],
        timePeriodIds: w.timePeriodIds ?? [],
        languageIds: w.languageIds ?? [],
        moodIds: w.moodIds ?? [],
        themeIds: w.themeIds ?? [],
    };
}

function anySet(w: WhitelistSetting): boolean {
    return w.playlistIds.length > 0
        || w.artistIds.length > 0
        || w.genreIds.length > 0
        || w.timePeriodIds.length > 0
        || w.languageIds.length > 0
        || (w.moodIds?.length ?? 0) > 0
        || (w.themeIds?.length ?? 0) > 0;
}

export class SongFilters {
    localOnly = false;
    whitelists: WhitelistSetting = emptyWhitelist();
    blacklists: WhitelistSetting = emptyWhitelist();
    // Energy band [energyMin, energyMax] (1-10); null = no bound. Songs with unknown energy are still included.
    energyMin: number | null = null;
    energyMax: number | null = null;
    // Audition-only narrowing: restrict the shuffle pool to songs that have NEVER been played, so a cohort
    // gives every track its first listen before repeating any. Set solely by the audition playlist play paths;
    // setSoleFilter clears it, so it can never leak from an audition session into an ordinary playlist.
    // Deliberately NOT part of hasAnyFilter(): on its own it does not define a pool, it only narrows one.
    unheardOnly = false;

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
        this.unheardOnly = false;

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
            case SongFilterType.Theme:
                this.whitelists.themeIds = ids;
                break;
        }
    }

    /** A copy without the audition narrowing — used for the fall-back pass once a cohort is fully heard. */
    public withoutUnheardOnly(): SongFilters {
        const copy: SongFilters = Object.assign(Object.create(SongFilters.prototype), this);
        copy.unheardOnly = false;
        return copy;
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
    Mood,
    Theme
};
