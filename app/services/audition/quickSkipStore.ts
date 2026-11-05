import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { parseQuickSkips } from "@/app/tools/auditionSession";

// Each audition mix's quick-skipped songs live on the device, never in the DB (ShuffullApp#177), so leaving the deck
// and coming back still deals them last. Per user, since one device can log in as several. Kept apart from
// auditionMode so the playlist delete can clear a list without pulling in the player.

const quickSkipsKey = (userId: string, playlistId: string) =>
    `${STORAGE_KEYS.AUDITION_QUICK_SKIPS_PREFIX}${userId}:${playlistId}`;

// Every write, in order, so a deck reopened at once reads what the last one left.
let writes: Promise<void> = Promise.resolve();

function queue(key: string, songIds: string[]) {
    writes = writes
        .then(() => songIds.length > 0 ? AsyncStorage.setItem(key, JSON.stringify(songIds)) : AsyncStorage.removeItem(key))
        .catch(e => console.warn("[audition] could not save quick skips", e));
}

/** Replaces the mix's list. An empty list removes it. */
export function saveQuickSkips(userId: string, playlistId: string, songIds: string[]): void {
    queue(quickSkipsKey(userId, playlistId), songIds);
}

/** Drops the mix's list, for a mix deleted on this device. */
export function forgetQuickSkips(userId: string, playlistId: string): void {
    queue(quickSkipsKey(userId, playlistId), []);
}

/** The mix's list, after any write still in flight. A list that can't be read counts as none. */
export async function loadQuickSkips(userId: string, playlistId: string): Promise<string[]> {
    await writes;
    try {
        return parseQuickSkips(await AsyncStorage.getItem(quickSkipsKey(userId, playlistId)));
    } catch (e) {
        // Without the list the skipped songs just come back in their old place.
        console.warn("[audition] could not read quick skips", e);
        return [];
    }
}
