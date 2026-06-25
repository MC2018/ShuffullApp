import { router } from "expo-router";
import { GenreJam } from "@/app/services/db/models";
import { SongFilters } from "@/app/types/SongFilters";
import { MediaManager } from "@/app/services/media-manager";

// Apply a saved (or transient) jam as the active shuffle and open the player. Shared by the Home
// "Your Jams" row, the Library Jams section, and the jam builder's "Start Jam".
export async function launchJam(jam: GenreJam): Promise<void> {
    const filters = SongFilters.fromGenreJam(jam, false);
    await MediaManager.setSongFilters(filters, true);
    router.push("/now-playing");
}

// One-line description of a saved jam's filters, for cards/rows.
export function jamSummary(jam: GenreJam): string {
    const moods = jam.whitelists?.moodIds?.length ?? 0;
    const parts: string[] = [];
    if (moods > 0) {
        parts.push(`${moods} mood${moods > 1 ? "s" : ""}`);
    }
    if (jam.energyMin && jam.energyMax) {
        parts.push(`energy ${jam.energyMin}–${jam.energyMax}`);
    }
    return parts.length ? parts.join(" · ") : "Tap to play";
}
