// Pure, dependency-free pieces lifted out of SyncManager.overallSync so they can be unit-tested without
// the surrounding native deps (expo-sqlite, async-storage, the API client). Behaviour is preserved
// exactly: SyncManager calls these in place of the inline logic it used to run.

// Minimal shapes these helpers need — kept local so the module imports nothing native. They are
// structurally compatible with ApiModels.Playlist / ApiModels.UserSong / ApiModels.ChangedSong.
export interface PlaylistVersionInfo {
    playlistId: string;
    version: Date;
}

// Which accessible playlists need a full re-fetch: ones we don't hold locally, or whose server
// `version` is newer than our local copy. Mirrors the original inline diff in overallSync.
export function playlistsToFetch(
    accessiblePlaylists: PlaylistVersionInfo[],
    localPlaylists: PlaylistVersionInfo[]
): string[] {
    const toFetch: string[] = [];

    for (const accessiblePlaylist of accessiblePlaylists) {
        const localPlaylist = localPlaylists.filter(x => x.playlistId == accessiblePlaylist.playlistId);
        if (!localPlaylist.length || localPlaylist[0].version < accessiblePlaylist.version) {
            toFetch.push(accessiblePlaylist.playlistId);
        }
    }

    return toFetch;
}

// Song IDs referenced by the updated playlists / user-songs that we don't already hold locally.
// De-duplicated (first occurrence wins) and filtered against the local set, exactly as overallSync did.
export function collectNewSongIds(
    updatedPlaylistSongIds: string[][],
    updatedUserSongIds: string[],
    localSongIds: string[]
): string[] {
    return [
        ...updatedPlaylistSongIds.flatMap(x => x),
        ...updatedUserSongIds,
    ]
        .filter((value, index, self) => self.indexOf(value) === index)
        .filter(songId => songId && !localSongIds.includes(songId));
}

// Cursor advancement for the incremental "changed songs" feed: when a page has items, the cursor moves
// to the newest Version on the page (across ALL changed songs, not just the local ones), so already-seen
// changes are never re-paged. An empty page leaves the cursor where it was.
export function advanceSongCursor<T extends { version: Date }>(
    pageItems: T[],
    currentCursor: Date
): Date {
    if (pageItems.length) {
        return pageItems[pageItems.length - 1].version;
    }

    return currentCursor;
}
