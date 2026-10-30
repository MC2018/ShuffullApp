// When to open a listen for a song that is playing with none open (ShuffullApp#57, ShuffullApp#143), and whether a
// fresh JS context carries on the last one's listen instead (ShuffullApp#147). mediaManager runs both under the
// transport lock: openListenForResume on a transition to Playing, recoverListensForRestart once setup() has the player.
// Kept apart from mediaManager, which imports native modules, so the rules can be tested.

import type { PlayingTrack } from "@/app/tools/listens";

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
 */
export async function openListenIfPlaying(input: ResumeListenInput): Promise<boolean> {
    const songId = await songToRecord(input);
    if (songId == undefined) {
        return false;
    }

    await input.begin(songId);
    return true;
}

export interface RestartListenInput extends ResumeListenInput {
    /** The player's position in the loaded track, in seconds. Asked only while it plays the current song. */
    positionSeconds: () => Promise<number>;
    /** ListenRecorder.recover: closes the last context's listens, but carries on the one for `playing` if it can. */
    recover: (playing?: PlayingTrack) => Promise<boolean>;
}

export type RestartListenOutcome = "tookOver" | "opened" | "none";

/**
 * A fresh JS context's listens: closes what the last context left open, and records the song still playing, if one is.
 *
 * When the last context's listen is still that play (listenToTakeOver), this context carries it on, so one play stays
 * one listen and a skip right after the restart isn't a quick skip (ShuffullApp#147). Otherwise, the old listen is
 * closed at its last checkpoint and a new one opens from now: what played in between is in neither, and the two never
 * count the same seconds. One play is then two listens, which the takeover rule only allows near a song's start.
 *
 * The orphans are closed whatever the player says, even if asking it fails.
 */
export async function recoverListensAfterRestart(input: RestartListenInput): Promise<RestartListenOutcome> {
    let playing: PlayingTrack | undefined;
    try {
        const songId = await songToRecord(input);
        if (songId != undefined) {
            const positionSeconds = await input.positionSeconds().catch(e => {
                console.warn("[listens] could not read the player's position; not carrying on the last run's listen", e);
                return NaN;
            });
            playing = { songId, positionSeconds };
        }
    } catch (e) {
        console.warn("[listens] could not ask the player what is playing; closing the last run's listens", e);
    }

    if (await input.recover(playing)) {
        return "tookOver";
    }
    if (playing == undefined) {
        return "none";
    }

    await input.begin(playing.songId);
    return "opened";
}

/** The current song, if it is playing as the loaded track with no listen open and audition mode closed. */
async function songToRecord(input: ResumeListenInput): Promise<string | undefined> {
    const songId = input.activeSongId;
    if (songId == undefined || input.openSongId != undefined || input.auditionOpen) {
        return undefined;
    }
    if (!await input.isPlaying() || await input.loadedTrackId() !== songId) {
        return undefined;
    }

    return songId;
}
