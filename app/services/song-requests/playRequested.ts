import { GenericDb } from "../db/GenericDb";
import DbQueries from "../db/queries";
import { MediaManager } from "../media-manager";
import { useActiveSong } from "../media-manager/mediaManager";
import { syncSoon } from "./useSongRequests";

/** How long "play it now" waits for a sync to bring a song this device doesn't have yet. Syncs run every 10 s. */
export const PLAY_WAIT_MS = 30_000;
const CHECK_EVERY_MS = 1_000;

/**
 * - "played": it is playing.
 * - "not-yet": it didn't arrive within PLAY_WAIT_MS. A later sync still brings it, but nothing plays it then.
 * - "cancelled": `signal` aborted, or another song started meanwhile, so the user has moved on.
 */
export type PlayWhenSyncedOutcome = "played" | "not-yet" | "cancelled";

/**
 * Plays a song the server just linked to the user: at once if this device has it, otherwise after the sync that brings
 * it down. Gives up when `signal` aborts (the screen closed, another play-now) or another song starts, so it never
 * switches the music under a user who moved on.
 */
export async function playWhenSynced(db: GenericDb, songId: string, signal: AbortSignal): Promise<PlayWhenSyncedOutcome> {
    const playing = useActiveSong.getState().songId;
    const movedOn = () => signal.aborted || useActiveSong.getState().songId !== playing;
    if (await DbQueries.getSong(db, songId)) {
        if (movedOn()) {
            return "cancelled";
        }
        await MediaManager.playSpecificSong(songId);
        return "played";
    }
    syncSoon();
    const deadline = Date.now() + PLAY_WAIT_MS;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, CHECK_EVERY_MS));
        if (movedOn()) {
            return "cancelled";
        }
        if (await DbQueries.getSong(db, songId)) {
            if (movedOn()) {
                return "cancelled";
            }
            await MediaManager.playSpecificSong(songId);
            return "played";
        }
    }
    return "not-yet";
}
