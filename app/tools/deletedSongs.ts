import { HttpStatusCode } from "axios";
import { isUnreachableStatus, statusOfFailure } from "../services/api/errors";
import type { DeletedSong, DeletedSongsPage } from "../services/api/models";

// Library › Deleted songs (ShuffullApp#59): the songs the server deleted for you (today, the un-kept songs of an
// audition mix you deleted), so a regretted delete can be looked up again. Read straight from the server each time the
// screen opens, never stored on the device. Everything here is pure, so it is unit-tested on its own.

/** A safety stop for the page loop: 50 pages of the API's 500 is far more than anyone has deleted. */
export const MAX_DELETED_PAGES = 50;

/**
 * Every deleted song, newest first, by following the API's cursor until its last page. Stops early if the server ever
 * hands back the cursor it was just given, so a server bug can't loop it forever.
 */
export async function loadAllDeletedSongs(fetchPage: (before?: string) => Promise<DeletedSongsPage>): Promise<DeletedSong[]> {
    const songs: DeletedSong[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_DELETED_PAGES; page++) {
        const result = await fetchPage(before);
        songs.push(...result.songs);
        if (result.nextBefore == null || result.nextBefore === before) {
            break;
        }
        before = result.nextBefore;
    }
    return songs;
}

/** The songs whose name, artists or mix contain the search text, ignoring case. Empty text keeps them all. */
export function filterDeletedSongs(songs: DeletedSong[], text: string): DeletedSong[] {
    const needle = text.trim().toLowerCase();
    if (!needle) {
        return songs;
    }
    return songs.filter((s) => [s.name, s.artistNames, s.playlistName].some((field) => field?.toLowerCase().includes(needle)));
}

// A YouTube video id: 11 characters from the URL-safe base64 set.
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The song's YouTube page, or null when its source id isn't a YouTube video id (or it has none). */
export function youtubeWatchUrl(externalSongId: string | null): string | null {
    return externalSongId != null && YOUTUBE_ID.test(externalSongId)
        ? `https://www.youtube.com/watch?v=${externalSongId}`
        : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 22", or "Oct 22, 2025" when it isn't this year. Local time, like the rest of the app's dates. */
export function describeDeletedDate(deletedAt: Date, now: Date): string {
    const day = `${MONTHS[deletedAt.getMonth()]} ${deletedAt.getDate()}`;
    return deletedAt.getFullYear() === now.getFullYear() ? day : `${day}, ${deletedAt.getFullYear()}`;
}

/** The row's second line: artists, when it was deleted, and the mix it was in, leaving out whatever isn't known. */
export function describeDeletedSong(song: DeletedSong, now: Date): string {
    return [
        song.artistNames ?? "Unknown Artist",
        `deleted ${describeDeletedDate(song.deletedAt, now)}`,
        song.playlistName != null ? `from ${song.playlistName}` : null,
    ].filter((part): part is string => part != null).join(" · ");
}

/** What the screen says when the list can't be read. */
export function describeDeletedSongsFailure(error: unknown): string {
    const status = statusOfFailure(error);
    if (status === HttpStatusCode.NotFound) {
        return "This server doesn't keep a list of deleted songs yet.";
    }
    if (isUnreachableStatus(status)) {
        return "Can't reach the server. The list of deleted songs needs a connection.";
    }
    return `Couldn't load your deleted songs (error ${status}). Try again.`;
}
