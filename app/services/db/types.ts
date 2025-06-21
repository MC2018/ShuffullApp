import { Artist, Song } from "./models";

export type WhitelistSetting = {
    artistIds: string[],
    playlistIds: string[],
    genreIds: string[],
    timePeriodIds: string[],
    languageIds: string[],
};

export enum DownloadPriority {
    Low = 1,
    Medium = 2,
    High = 3
}

export type SongDetails = {
    song: Song;
    artists: Artist[];
}
