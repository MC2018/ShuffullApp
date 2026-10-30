import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useApi } from "../api/ApiProvider";
import { useCurrentUser } from "../auth/CurrentUserProvider";
import { loadRecap, readSavedRecap } from "./recapLoader";
import { deviceTimeZone, isRecapSeason, RECAP_BUTTON_REFRESH_MS, recapButtonVisible, recapYear } from "../../tools/recap";

// When this app session last asked the server, per user and year. A failed ask (offline, or an API without the
// endpoint yet) isn't saved anywhere, so without this every visit to Home in December would ask again.
const lastAsked = new Map<string, number>();
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;

/**
 * Whether Home shows the recap button: only in December, local time, and only once the year has a listen. Outside
 * December it does nothing at all, no storage read and no network. In December it shows the saved copy's answer at
 * once, and asks the server again when that copy is over RECAP_BUTTON_REFRESH_MS old.
 */
export function useRecapButton(): { visible: boolean; year: number } {
    const api = useApi();
    const userId = useCurrentUser();
    const [plays, setPlays] = useState<number | null>(null);
    const now = new Date();

    useFocusEffect(
        useCallback(() => {
            const focusedAt = new Date();
            if (!isRecapSeason(focusedAt)) {
                setPlays(null);
                return;
            }
            const year = recapYear(focusedAt);
            const key = `${userId}:${year}`;
            let cancelled = false;
            (async () => {
                const saved = await readSavedRecap(userId, year);
                if (cancelled) {
                    return;
                }
                setPlays(saved?.recap.plays ?? null);
                if (saved && Date.now() - saved.fetchedAt < RECAP_BUTTON_REFRESH_MS) {
                    return;
                }
                const asked = lastAsked.get(key);
                if (asked != null && Date.now() - asked < RETRY_AFTER_FAILURE_MS) {
                    return;
                }
                lastAsked.set(key, Date.now());
                const load = await loadRecap(api, userId, year, deviceTimeZone(focusedAt));
                if (!cancelled && load.status === "ready") {
                    setPlays(load.recap.plays);
                }
            })();
            return () => {
                cancelled = true;
            };
        }, [api, userId]),
    );

    return { visible: recapButtonVisible(now, plays), year: recapYear(now) };
}
