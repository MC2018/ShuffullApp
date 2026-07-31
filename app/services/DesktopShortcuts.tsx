import { useEffect } from "react";
import { useDb } from "./db/DbProvider";
import DbQueries from "./db/queries";
import { MediaManager } from "./media-manager";
import { LikeStatus } from "../enums";

/**
 * Wires the desktop shell's GLOBAL rating shortcuts to the media manager.
 *
 * The Electron preload exposes `window.shuffull`; it is absent on mobile and in a plain browser, so this
 * mounts everywhere and simply does nothing where there is no shell. That feature check is deliberately the
 * only platform branch - no `.web.tsx` twin to keep in sync.
 *
 * Every action targets the CURRENTLY PLAYING song, because that is the only song the user can be referring to
 * while the app is in the background.
 */

type ShortcutAction = "like" | "love" | "dislike" | "keep" | "neutral";

interface ShuffullBridge {
    onRatingShortcut: (callback: (action: ShortcutAction) => void) => () => void;
    notify: (title: string, body: string) => void;
}

function bridge(): ShuffullBridge | undefined {
    return (globalThis as unknown as { shuffull?: ShuffullBridge }).shuffull;
}

export default function DesktopShortcuts() {
    const db = useDb();

    useEffect(() => {
        const shell = bridge();
        if (!shell) {
            return;
        }

        const unsubscribe = shell.onRatingShortcut(async (action) => {
            try {
                const songId = MediaManager.useActiveSong.getState().songId;
                if (songId == undefined) {
                    shell.notify("Shuffull", "Nothing is playing.");
                    return;
                }

                // Read the song for its title, and (for Keep) to know whether the action even applies.
                const song = await DbQueries.getSong(db, songId);
                const label = song?.name ?? "this song";

                if (action === "keep") {
                    // Keep is an AUDITION action - it retains a song with cheap tags instead of letting it die
                    // with the cohort. It is a no-op for anything else, so say so rather than appear to work.
                    if (!song?.exploratory) {
                        shell.notify("Shuffull", `${label} isn't an audition song — nothing to keep.`);
                        return;
                    }
                    await MediaManager.keepSong(songId);
                    shell.notify("Kept", label);
                    return;
                }

                const status =
                    action === "like" ? LikeStatus.Like :
                    action === "love" ? LikeStatus.Love :
                    action === "dislike" ? LikeStatus.Dislike :
                    LikeStatus.Neutral;

                // Toggle: pressing the same rating again clears it, so one key both sets and unsets.
                const current = MediaManager.useLikeStatus.getState().statuses[songId];
                const next = current === status && status !== LikeStatus.Neutral ? LikeStatus.Neutral : status;

                await MediaManager.applyLikeStatus(songId, next);

                const verb =
                    next === LikeStatus.Like ? "Liked" :
                    next === LikeStatus.Love ? "Loved" :
                    next === LikeStatus.Dislike ? "Disliked" :
                    "Rating cleared for";
                shell.notify(verb, label);
            } catch (e) {
                // A global shortcut that throws would otherwise fail completely silently - the user is not
                // looking at the app, and there is no UI to show an error in.
                console.error("Rating shortcut failed:", e);
                shell.notify("Shuffull", "That didn't work — see the app for details.");
            }
        });

        return unsubscribe;
    }, [db]);

    return null;
}
