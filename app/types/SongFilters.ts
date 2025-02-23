export class SongFilters {
    localOnly = false;
    playlistIds: number[] = [];
    artistIds: number[] = [];
    genreIds: number[] = [];

    public setPrimaryFilter(type: SongFilterType, ids: number[]) {
        this.playlistIds = [];
        this.artistIds = [];
        this.genreIds = [];
        
        switch (type) {
            case SongFilterType.Artist:
                this.artistIds = ids;
                break;
            case SongFilterType.Genre:
                this.genreIds = ids;
                break;
            case SongFilterType.Playlist:
                this.playlistIds = ids;
                break;
        }
    }

    hasAnyFilter(songFilters: SongFilters): boolean {
        return songFilters.artistIds.length > 0
            || songFilters.genreIds.length > 0
            || songFilters.localOnly
            || songFilters.playlistIds.length > 0;
    }
};

export enum SongFilterType {
    Playlist,
    Artist,
    Genre
};
