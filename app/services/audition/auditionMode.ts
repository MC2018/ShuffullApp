import TrackPlayer, { State } from "react-native-track-player";
import { create } from "zustand";
import { GenericDb } from "../db/GenericDb";
import DbQueries from "../db/queries";
import { MediaManager } from "../media-manager";
import { AuditionController, useActiveSong } from "../media-manager/mediaManager";
import { AuditionPort, AuditionSession, AuditionSnapshot } from "@/app/tools/auditionSession";

// Audition mode's one live session (ShuffullApp#125), between the deck screen and the player. The rules live in
// tools/auditionSession; this file only plugs the real player into them and keeps the screen's copy current.

interface AuditionModeState {
    snapshot: AuditionSnapshot | undefined;
}

export const useAuditionMode = create<AuditionModeState>(() => ({ snapshot: undefined }));

type Active = {
    session: AuditionSession;
    controller: AuditionController;
    timer: ReturnType<typeof setInterval>;
    unsubscribe: () => void;
};

let active: Active | undefined;
// Bumped by every start and stop, so a start that is still reading the deck when the screen closes gives up.
let generation = 0;

// The player functions that do NOT route back into the deck: the routed ones (play, skip, previous) would call
// the session again and wait on themselves.
const port: AuditionPort = {
    load: (songId, startFraction, previous) => MediaManager.playAuditionSong(songId, startFraction, previous),
    resume: () => MediaManager.auditionResume(),
    pause: () => MediaManager.auditionPause(),
    seekTo: seconds => MediaManager.seekTo(seconds),
    rate: (songId, likeStatus) => MediaManager.applyLikeStatus(songId, likeStatus),
    keep: songId => MediaManager.keepSong(songId),
    markHeard: songId => MediaManager.markAuditionHeard(songId),
    prefetch: songIds => void MediaManager.prefetchAudition(songIds).catch(e => console.warn("[audition] prefetch failed", e)),
};

/** Deals out `playlistId`'s unheard songs and starts the first. Returns the session, or undefined if superseded. */
export async function startAuditionMode(db: GenericDb, playlistId: string): Promise<AuditionSession | undefined> {
    await stopAuditionMode();
    const myGeneration = ++generation;

    const sessionData = await DbQueries.getActiveLocalSessionData(db);
    if (!sessionData || myGeneration !== generation) {
        return undefined;
    }
    const songIds = await DbQueries.getAuditionDeckSongIds(db, sessionData.userId, playlistId);
    if (myGeneration !== generation) {
        return undefined;
    }

    const session = new AuditionSession(songIds, port);
    const controller: AuditionController = {
        resume: () => session.resume(),
        next: () => session.next(),
        previous: () => session.previous(),
        rate: likeStatus => session.rateFromRemote(likeStatus),
        keep: () => session.keep(),
        onPlaybackState: playing => session.onPlaybackState(playing),
        onEnded: songId => session.onEnded(songId),
    };
    const unsubscribe = session.subscribe(() => useAuditionMode.setState({ snapshot: session.snapshot() }));
    const timer = setInterval(() => void tick(session), 1000);
    active = { session, controller, timer, unsubscribe };
    useAuditionMode.setState({ snapshot: session.snapshot() });

    await MediaManager.beginAuditionMode(playlistId, controller);
    await session.start();
    return session;
}

/** Gives the player back to the normal shuffle. Safe to call when no session is running. */
export async function stopAuditionMode(): Promise<void> {
    generation++;
    const current = active;
    if (current == undefined) {
        return;
    }
    active = undefined;
    clearInterval(current.timer);
    current.unsubscribe();
    // Settles the clock of the song on screen, so time heard right up to leaving still counts.
    current.session.onPlaybackState(false);
    current.session.tick();
    useAuditionMode.setState({ snapshot: undefined });
    await MediaManager.endAuditionMode(current.controller);
}

async function tick(session: AuditionSession) {
    try {
        const [{ duration }, { state }] = await Promise.all([TrackPlayer.getProgress(), TrackPlayer.getPlaybackState()]);
        session.tick(duration, state === State.Playing, useActiveSong.getState().songId);
    } catch (e) {
        console.warn("[audition] tick failed", e);
    }
}
