import { useCallback, useEffect, useState } from "react";
import { ImageURISource } from "react-native";
import { useFocusEffect } from "expo-router";
import DbQueries from "@/app/services/db/queries";
import { PlayHistoryItem } from "@/app/services/db/queries/playHistory";
import { Song } from "@/app/services/db/models";
import { useDb } from "@/app/services/db/DbProvider";
import { useCurrentUser } from "@/app/services/auth/CurrentUserProvider";
import { useActiveSong } from "@/app/services/media-manager/mediaManager";
import { Downloader } from "@/app/services/downloader/Downloader";

/**
 * The user's play history, newest first, reloaded whenever the screen regains focus and whenever the song changes.
 * A song change is when a row appears: the player closes the old listen (writing its row) before it sets the new song.
 */
export function usePlayHistory(limit?: number): { plays: PlayHistoryItem[]; loaded: boolean } {
    const db = useDb();
    const userId = useCurrentUser();
    const { songId } = useActiveSong();
    const [plays, setPlays] = useState<PlayHistoryItem[]>([]);
    const [loaded, setLoaded] = useState(false);
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
                }
            } catch (e) {
                console.warn("[history] could not load the play history", e);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [db, userId, limit, songId, focused]);

    return { plays, loaded };
}

const defaultArt: ImageURISource = require("@/assets/images/default-album-art.jpg");

/** A song's album art: the downloaded file if there is one, else the server's. The default art until it resolves. */
export function useSongArt(song: Song): ImageURISource {
    const [art, setArt] = useState<ImageURISource>(defaultArt);
    useEffect(() => {
        let cancelled = false;
        Downloader.resolveAlbumArt(song)
            .then((resolved) => {
                if (!cancelled) {
                    setArt(resolved);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
        // The art is keyed by the song and its file, not by the object, which is new on every reload.
    }, [song.songId, song.fileHash]); // eslint-disable-line react-hooks/exhaustive-deps
    return art;
}
