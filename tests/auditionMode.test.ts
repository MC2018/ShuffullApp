import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAuditionMode, stopAuditionMode, useAuditionMode } from "@/app/services/audition/auditionMode";
import type { GenericDb } from "@/app/services/db/GenericDb";

// startAuditionMode against a stubbed player and database: only whether a deck begins is under test here. The deck's
// own rules are auditionSession.test.ts. vi.mock is hoisted above the imports.
const player = vi.hoisted(() => ({
    beginAuditionMode: vi.fn(async () => {}),
    endAuditionMode: vi.fn(async () => {}),
    playAuditionSong: vi.fn(async () => {}),
}));

vi.mock("react-native-track-player", () => ({
    default: { getProgress: async () => ({ duration: 0 }), getPlaybackState: async () => ({ state: "paused" }) },
    State: { Playing: "playing" },
}));
vi.mock("@/app/services/media-manager/mediaManager", () => ({
    useActiveSong: { getState: () => ({ songId: undefined }) },
}));
vi.mock("@/app/services/media-manager", () => ({
    MediaManager: { ...player, isAppInForeground: () => true, prefetchAudition: async () => {} },
}));
vi.mock("@/app/services/db/queries", () => ({
    default: {
        getActiveLocalSessionData: async () => ({ userId: "user-1" }),
        getAuditionDeckSongIds: async () => ["song-1", "song-2"],
    },
}));
vi.mock("@/app/services/audition/quickSkipStore", () => ({
    loadQuickSkips: async () => [],
    saveQuickSkips: () => {},
}));

const db = {} as GenericDb;

describe("startAuditionMode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(async () => {
        await stopAuditionMode();
    });

    it("begins a deck and plays its first song", async () => {
        const session = await startAuditionMode(db, "mix-1", new AbortController().signal);

        expect(session).toBeDefined();
        expect(player.beginAuditionMode).toHaveBeenCalledWith("mix-1", expect.anything());
        expect(player.playAuditionSong).toHaveBeenCalledTimes(1);
    });

    it("begins nothing once its screen has closed, so no hidden deck is left driving the player (ShuffullApp#187)", async () => {
        // The screen closed while its playlist read held the start up: its cleanup aborted, and stopped nothing.
        const abort = new AbortController();
        abort.abort();
        await stopAuditionMode();

        const session = await startAuditionMode(db, "mix-1", abort.signal);

        expect(session).toBeUndefined();
        expect(player.beginAuditionMode).not.toHaveBeenCalled();
        expect(player.playAuditionSong).not.toHaveBeenCalled();
        expect(useAuditionMode.getState().snapshot).toBeUndefined();
    });
});
