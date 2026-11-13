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
    // Heaviness band [heavinessMin, heavinessMax] (1-10); null = no bound. A song with unknown (null) heaviness matches
    // only while BOTH bounds are null -- setting either one excludes it, since an unrated song cannot be shown
    // to fall in the band.
    heavinessMin: number | null = null;
    heavinessMax: number | null = null;
    // Audition-only narrowing: restrict the shuffle pool to songs that have NEVER been played, so a cohort
    // gives every track its first listen before repeating any. Set solely by the audition playlist play paths;
    // setSoleFilter clears it, so it can never leak from an audition session into an ordinary playlist.
    // Deliberately NOT part of hasAnyFilter(): on its own it does not define a pool, it only narrows one.
    unheardOnly = false;
    // The scope came from a genre jam, so its listens record that context. Set only by fromGenreJam; setSoleFilter
    // clears it, like unheardOnly. Filters saved before it existed parse without it, which reads as false.
    genreJam = false;

    public static fromGenreJam(genreJam: GenreJam, localOnly: boolean): SongFilters {
        const songFilters = new SongFilters();

        songFilters.localOnly = localOnly;
        songFilters.whitelists = normalizeWhitelist(genreJam.whitelists);
        songFilters.blacklists = normalizeWhitelist(genreJam.blacklists);
        songFilters.heavinessMin = genreJam.heavinessMin ?? null;
        songFilters.heavinessMax = genreJam.heavinessMax ?? null;
        songFilters.genreJam = true;

        return songFilters;
    }

    /**
     * Makes this the whole scope: one filter and nothing else. Callers build on the SAVED filters (a playlist's or
     * an artist's Play button), so anything left standing here leaks from the last scope into this one. A Genre
     * Jam's heaviness band, and the Downloads list's local-only, used to: the band then excluded every song with no
     * heaviness score, which left an audition mix (almost none scored) playing the same one song every time
     * (ShuffullApp#185). Resetting from a fresh instance means a field added later starts at its default without
     * anyone having to remember to clear it here.
     */
    public setSoleFilter(type: SongFilterType, ids: string[]) {
        Object.assign(this, new SongFilters());

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

    // The same scope, narrowed to downloaded songs: what the shuffle plays while the server can't be reached.
    public withLocalOnly(): SongFilters {
        const copy: SongFilters = Object.assign(Object.create(SongFilters.prototype), this);
        copy.localOnly = true;
        return copy;
    }

    hasAnyFilter(): boolean {
        return this.localOnly || this.hasAnyWhitelistFilter() || this.hasAnyBlacklistFilter() || this.heavinessMin != null || this.heavinessMax != null;
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
