export enum RequestType {
    UpdateSongLastPlayed = 0,
    Authenticate = 1,
    OverallSync = 2,
    CreateUserSong = 3,
    SetSongLikeStatus = 4,
    FlagSongForReplacement = 5,
    UpdateSongMetadata = 6,
    // Re-tag a song via POST /songs/retag. Used to promote an audition song on keep (the server enriches it
    // and clears its Exploratory flag). Batched so many kept songs coalesce into one call.
    SongRetag = 7,
    // Delete a playlist via DELETE /playlists/{id}. For an audition playlist the server purges the un-kept songs.
    DeletePlaylist = 8
};
