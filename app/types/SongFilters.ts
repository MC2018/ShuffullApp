import { GenreJam } from "../services/db/models";
import { WhitelistSetting } from "../services/db/types";

export class SongFilters {
    localOnly = false;
    whitelists: WhitelistSetting = {
        artistIds: [],
        playlistIds: [],
        genreIds: [],
        timePeriodIds: [],
        languageIds: [],
    };
    blacklists: WhitelistSetting = {
        artistIds: [],
        playlistIds: [],
        genreIds: [],
        timePeriodIds: [],
        languageIds: [],
    };

    public static fromGenreJam(genreJam: GenreJam, localOnly: boolean): SongFilters {
        const songFilters = new SongFilters();

        songFilters.localOnly = localOnly;
        songFilters.whitelists = {
            artistIds: genreJam.whitelists.artistIds,
            playlistIds: genreJam.whitelists.playlistIds,
            genreIds: genreJam.whitelists.genreIds,
            timePeriodIds: genreJam.whitelists.timePeriodIds,
            languageIds: genreJam.whitelists.languageIds,
        };
        songFilters.blacklists = {
            artistIds: genreJam.blacklists.artistIds,
            playlistIds: genreJam.blacklists.playlistIds,
            genreIds: genreJam.blacklists.genreIds,
            timePeriodIds: genreJam.blacklists.timePeriodIds,
            languageIds: genreJam.blacklists.languageIds,
        };

        return songFilters;
    }

    public setSoleFilter(type: SongFilterType, ids: number[]) {
        this.whitelists = {
            artistIds: [],
            playlistIds: [],
            genreIds: [],
            timePeriodIds: [],
            languageIds: [],
        };
        this.blacklists = {
            artistIds: [],
            playlistIds: [],
            genreIds: [],
            timePeriodIds: [],
            languageIds: [],
        };
        
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
        }
    }

    hasAnyFilter(): boolean {
        return this.localOnly || this.hasAnyWhitelistFilter() || this.hasAnyBlacklistFilter();
    }

    hasAnyWhitelistFilter(): boolean {
        return this.whitelists.playlistIds.length > 0
            || this.whitelists.artistIds.length > 0
            || this.whitelists.genreIds.length > 0
            || this.whitelists.timePeriodIds.length > 0
            || this.whitelists.languageIds.length > 0
    }

    hasAnyBlacklistFilter(): boolean {
        return this.blacklists.playlistIds.length > 0
            || this.blacklists.artistIds.length > 0
            || this.blacklists.genreIds.length > 0
            || this.blacklists.timePeriodIds.length > 0
            || this.blacklists.languageIds.length > 0
    }
};

export enum SongFilterType {
    Playlist,
    Artist,
    Genre,
    TimePeriod,
    Language
};
