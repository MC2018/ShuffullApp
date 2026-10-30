// When to open a listen for a song that is playing with none open (ShuffullApp#57, ShuffullApp#143). mediaManager's
// openListenForResume runs it under the transport lock, on a transition to Playing and once at the end of setup().
// Kept apart from mediaManager, which imports native modules, so the rule can be tested.

export interface ResumeListenInput {
    /** The song the app shows as the current one. */
    activeSongId: string | undefined;
    /** The song of the listen already open, if any (ListenRecorder.openSongId). */
    openSongId: string | undefined;
    /** Audition mode is open. Its deck opens every listen itself (playAuditionSong). */
    auditionOpen: boolean;
    /** Whether the player is in State.Playing. */
    isPlaying: () => Promise<boolean>;
    /** The id (a song id) of the track the player has loaded. Asked only while it plays. */
    loadedTrackId: () => Promise<string | undefined>;
    /** Opens a listen for `songId`, already playing. */
    begin: (songId: string) => Promise<void>;
}

/**
 * Opens a listen for the current song if it is playing and none is open. Returns whether it began one.
 *
 * The loaded track must be the current song: after a JS restart the current song comes from the database, while the
 * player may be playing something that never wrote there, such as an audition deck song. Recording the database's
 * song then would log a play of a song that isn't playing.
 *
 * A listen a previous JS context left open has been closed by ListenRecorder.recover() at its last checkpoint, which
 * is never later than now. The listen this opens starts now, so the two never count the same seconds; what played
 * between that checkpoint and now (up to one checkpoint interval, plus the restart) is in neither. One play is then
 * two listens, so a skip soon after the restart counts as a quick skip on the server; ShuffullApp#147 tracks that.
 */
export async function openListenIfPlaying(input: ResumeListenInput): Promise<boolean> {
    const songId = input.activeSongId;
    if (songId == undefined || input.openSongId != undefined || input.auditionOpen) {
        return false;
    }
    if (!await input.isPlaying() || await input.loadedTrackId() !== songId) {
        return false;
    }

    await input.begin(songId);
    return true;
}
