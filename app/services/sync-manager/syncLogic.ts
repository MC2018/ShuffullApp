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

// One queued re-tag row's shape, as this helper needs it (structurally compatible with
// DbModels.SongRetagRequest). Absent payload (legacy row) means strong.
export interface QueuedRetag {
    songId: string | null;
    payload?: { model?: string } | null;
}

// Maps the queued re-tag rows to the wire's per-item shape ({songId, model}) for ONE burst call.
// Defensive stronger-wins dedupe: the enqueue helper already maintains one row per song, but legacy or
// hand-inserted duplicates must never demote a strong request (mirrors the server's collapse rule).
export function toRetagItems(requests: QueuedRetag[]): { songId: string; model: "weak" | "strong" }[] {
    const modelBySong = new Map<string, "weak" | "strong">();
    for (const request of requests) {
        if (!request.songId) {
            continue;
        }
        const model: "weak" | "strong" = request.payload?.model === "weak" ? "weak" : "strong";
        const existing = modelBySong.get(request.songId);
        if (existing === undefined || (existing === "weak" && model === "strong")) {
            modelBySong.set(request.songId, model);
        }
    }
    return [...modelBySong.entries()].map(([songId, model]) => ({ songId, model }));
}
