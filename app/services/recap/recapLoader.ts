import AsyncStorage from "@react-native-async-storage/async-storage";
import { HttpStatusCode } from "axios";
import type { ApiClient } from "../api/ApiClient";
import { statusOfFailure } from "../api/errors";
import { Recap, RecapSchema } from "../api/models";
import { recapCacheKey } from "../../tools/recap";

export interface SavedRecap {
    recap: Recap;
    /** Epoch ms of the fetch that produced it. */
    fetchedAt: number;
}

/**
 * What loading a recap came to.
 * - `ready`: a recap to show. `saved` is set when it is the last fetched copy because the fetch just failed.
 * - `unavailable`: the server has no recap endpoint yet (404: an API older than Shuffull#62). Said quietly.
 * - `offline`: no answer and no saved copy.
 * - `error`: the server answered with something else, and there's no saved copy.
 */
export type RecapLoad =
    | { status: "ready"; recap: Recap; fetchedAt: number; saved: boolean }
    | { status: "unavailable" }
    | { status: "offline" }
    | { status: "error"; httpStatus: number };

/** The last fetched copy of this user's recap of that year, or null. A copy that no longer parses is ignored. */
export async function readSavedRecap(userId: string, year: number): Promise<SavedRecap | null> {
    try {
        const raw = await AsyncStorage.getItem(recapCacheKey(userId, year));
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw) as { fetchedAt?: unknown; recap?: unknown };
        const recap = RecapSchema.safeParse(parsed.recap);
        if (!recap.success || typeof parsed.fetchedAt !== "number") {
            return null;
        }
        return { recap: recap.data, fetchedAt: parsed.fetchedAt };
    } catch {
        return null;
    }
}

async function saveRecap(userId: string, year: number, saved: SavedRecap): Promise<void> {
    try {
        await AsyncStorage.setItem(recapCacheKey(userId, year), JSON.stringify(saved));
    } catch (error) {
        // Only the offline copy is lost; the recap on screen is fine.
        console.log("[Recap] Couldn't save the recap for offline use:", error);
    }
}

/**
 * Fetches the recap and saves it for offline use. When the fetch fails, the last fetched copy is shown instead, if
 * there is one. Nothing here throws: every outcome is a RecapLoad.
 */
export async function loadRecap(api: ApiClient, userId: string, year: number, timeZone: string): Promise<RecapLoad> {
    try {
        const recap = await api.recapGet(year, timeZone);
        const fetchedAt = Date.now();
        await saveRecap(userId, year, { recap, fetchedAt });
        return { status: "ready", recap, fetchedAt, saved: false };
    } catch (error) {
        const saved = await readSavedRecap(userId, year);
        if (saved) {
            return { status: "ready", recap: saved.recap, fetchedAt: saved.fetchedAt, saved: true };
        }
        return failureLoad(statusOfFailure(error));
    }
}

/** A failed fetch with no saved copy to fall back on, by the status statusOfFailure gives it. */
export function failureLoad(httpStatus: number): RecapLoad {
    if (httpStatus === HttpStatusCode.NotFound) {
        return { status: "unavailable" };
    }
    if (httpStatus === HttpStatusCode.ServiceUnavailable) {
        return { status: "offline" };
    }
    return { status: "error", httpStatus };
}
