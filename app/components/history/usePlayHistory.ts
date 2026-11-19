import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";
import DbQueries from "@/app/services/db/queries";
import { PlayHistoryItem } from "@/app/services/db/queries/playHistory";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import { useActiveSong } from "@/app/services/media-manager/mediaManager";

/**
 * The user's play history, newest first, reloaded whenever the screen regains focus and whenever the song changes.
 * A song change is when a row appears: the player closes the old listen (writing its row) before it sets the new song.
 */
export function usePlayHistory(limit?: number): { plays: PlayHistoryItem[]; loaded: boolean; failed: boolean } {
    const db = useDb();
    const userId = useCurrentUser();
    const { songId } = useActiveSong();
    const [plays, setPlays] = useState<PlayHistoryItem[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);
    const [focused, setFocused] = useState(false);

    useFocusEffect(
        useCallback(() => {
            setFocused(true);
            return () => setFocused(false);
        }, []),
    );

    useEffect(() => {
        if (!focused) {
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const loadedPlays = await DbQueries.getPlayHistory(db, userId, limit);
                if (!cancelled) {
                    setPlays(loadedPlays);
                    setLoaded(true);
                    setFailed(false);
                }
            } catch (e) {
                console.warn("[history] could not load the play history", e);
                if (!cancelled) {
                    setFailed(true);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [db, userId, limit, songId, focused]);

    return { plays, loaded, failed };
}
