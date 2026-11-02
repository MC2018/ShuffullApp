import { GenericDb } from "../db/GenericDb";
import DbQueries from "../db/queries";
import { MediaManager } from "../media-manager";
import { syncSoon } from "./useSongRequests";

/** How long "play it now" waits for a sync to bring a song this device doesn't have yet. Syncs run every 10 s. */
export const PLAY_WAIT_MS = 30_000;
const CHECK_EVERY_MS = 1_000;

/**
 * Plays a song the server just linked to the user: at once if this device has it, otherwise after the sync that brings
 * it down. False if it didn't arrive within PLAY_WAIT_MS (it still will, with a later sync).
 */
export async function playWhenSynced(db: GenericDb, songId: string): Promise<boolean> {
    if (await DbQueries.getSong(db, songId)) {
        await MediaManager.playSpecificSong(songId);
        return true;
    }
    syncSoon();
    const deadline = Date.now() + PLAY_WAIT_MS;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, CHECK_EVERY_MS));
        if (await DbQueries.getSong(db, songId)) {
            await MediaManager.playSpecificSong(songId);
            return true;
        }
    }
    return false;
}
