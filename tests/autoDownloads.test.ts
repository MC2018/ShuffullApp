import { describe, it, expect } from "vitest";
import {
    AUTO_DOWNLOAD_DELAY_MS,
    AutoDownloadSettings,
    autoDownloadFits,
    CandidatePlaylist,
    CandidateSong,
    DEFAULT_AUTO_DOWNLOAD_SETTINGS,
    DEFAULT_FREE_FLOOR_BYTES,
    diffAutoDownloads,
    Difference,
    DownloadSource,
    fileHashesToDelete,
    isUnheard,
    mixWeekOf,
    normalizeSettings,
    PendingDifference,
    planReconcile,
    wantedSongIds,
    wantsAnything,
} from "@/app/tools/autoDownloads";

// ShuffullApp#225, the engine of auto-downloads (epic shuffull-workspace#150). What the user cares about most: nothing
// downloads or deletes the moment they tap. A difference has to hold for 10 minutes, so a mis-tap can be undone.

const NEUTRAL = 0;
const LIKE = 1;
const LOVE = 2;
const DISLIKE = 3;
const MINUTE = 60 * 1000;
const NOW = Date.UTC(2026, 10, 23, 12); // Mon 23 Nov 2026

function song(songId: string, patch: Partial<CandidateSong> = {}): CandidateSong {
    return { songId, exploratory: false, likeStatus: NEUTRAL, lastPlayedMs: NOW - 1000, hidden: false, ...patch };
}

function settings(patch: Partial<AutoDownloadSettings>): AutoDownloadSettings {
    return { ...DEFAULT_AUTO_DOWNLOAD_SETTINGS, ...patch };
}

function playlist(playlistId: string, name: string, songIds: string[], isExploratory = true): CandidatePlaylist {
    return { playlistId, name, isExploratory, songIds };
}

const library = [
    song("loved", { likeStatus: LOVE }),
    song("liked", { likeStatus: LIKE }),
    song("kept"), // not exploratory: in the library
    song("audition", { exploratory: true }),
    song("audition-liked", { exploratory: true, likeStatus: LIKE }),
    song("disliked", { likeStatus: DISLIKE }),
    song("hidden-loved", { likeStatus: LOVE, hidden: true }),
];

const wanted = (patch: Partial<AutoDownloadSettings>, playlists: CandidatePlaylist[] = []) =>
    wantedSongIds({ settings: settings(patch), songs: library, playlists, nowMs: NOW });

describe("settings", () => {
    it("default to Off with a 5 GB floor, wanting nothing, so an existing install changes nothing", () => {
        expect(normalizeSettings(undefined)).toEqual({
            tier: "off", mixWeeks: 0, mixUnheardOnly: false, subscriptions: false, playlistIds: [], freeFloorBytes: 5 * 1024 ** 3,
        });
        expect(wantsAnything(normalizeSettings(undefined))).toBe(false);
        expect(wanted({})).toEqual([]);
    });

    it("repair a row another build wrote", () => {
        const raw = { tier: "bogus", mixWeeks: 99, freeFloorBytes: -1, playlistIds: ["p1", 7] } as unknown as Partial<AutoDownloadSettings>;
        expect(normalizeSettings(raw)).toMatchObject({ tier: "off", mixWeeks: 10, freeFloorBytes: DEFAULT_FREE_FLOOR_BYTES, playlistIds: ["p1"] });
    });

    it("want something once any extra is on, even with the tier Off", () => {
        expect(wantsAnything(settings({ mixWeeks: 1 }))).toBe(true);
        expect(wantsAnything(settings({ subscriptions: true }))).toBe(true);
        expect(wantsAnything(settings({ playlistIds: ["p"] }))).toBe(true);
    });
});

describe("wantedSongIds", () => {
    it("climbs the ladder, each step including the ones before, best songs first", () => {
        expect(wanted({ tier: "loved" })).toEqual(["loved"]);
        expect(wanted({ tier: "liked" })).toEqual(["loved", "audition-liked", "liked"]);
        expect(wanted({ tier: "library" })).toEqual(["loved", "audition-liked", "liked", "kept"]);
        expect(wanted({ tier: "all" })).toEqual(["loved", "audition-liked", "liked", "kept", "audition"]);
    });

    it("never wants a disliked song or one hidden as a duplicate, whatever picks it", () => {
        const everything = playlist("p", "Mine", library.map((x) => x.songId), false);
        expect(wanted({ tier: "all", playlistIds: ["p"] }, [everything])).not.toContain("disliked");
        expect(wanted({ tier: "all", playlistIds: ["p"] }, [everything])).not.toContain("hidden-loved");
    });

    it("adds chosen playlists whatever the tier, and skips a song this device has no row for", () => {
        const chosen = playlist("p", "Road trip", ["audition", "gone"], false);
        expect(wanted({ playlistIds: ["p"] }, [chosen])).toEqual(["audition"]);
        expect(wanted({ playlistIds: [] }, [chosen])).toEqual([]);
    });

    it("adds Subscriptions only when asked, and only the user's own audition playlist of that name", () => {
        const subs = playlist("s", "Subscriptions", ["audition"]);
        const lookalike = playlist("x", "Subscriptions", ["kept"], false);
        expect(wanted({ subscriptions: true }, [subs, lookalike])).toEqual(["audition"]);
        expect(wanted({ subscriptions: false }, [subs])).toEqual([]);
    });

    it("keeps the latest N weeks of mixes, counting weeks, not playlists", () => {
        const mixes = [
            playlist("d23", "Discover Mix · Nov 23", ["audition"]),
            playlist("r23", "New Release Mix · Nov 23", ["audition-liked"]),
            playlist("d16", "Discover Mix · Nov 16", ["kept"]),
            playlist("d9", "Discover Mix · Nov 9", ["liked"]),
            playlist("shared", "Discover Mix · Nov 23", ["loved"], false), // not the user's own: never a mix
        ];
        expect(wanted({ mixWeeks: 1 }, mixes).sort()).toEqual(["audition", "audition-liked"]);
        expect(wanted({ mixWeeks: 2 }, mixes).sort()).toEqual(["audition", "audition-liked", "kept"]);
    });

    it("with unheard-only, keeps mix songs not played yet plus any kept or liked", () => {
        const songs = [
            song("heard", { exploratory: true }),
            song("never", { exploratory: true, lastPlayedMs: 0 }),
            song("heard-but-kept", { exploratory: false }),
            song("heard-but-liked", { exploratory: true, likeStatus: LIKE }),
        ];
        const mix = playlist("m", "Discover Mix · Nov 23", songs.map((x) => x.songId));
        const result = wantedSongIds({ settings: settings({ mixWeeks: 1, mixUnheardOnly: true }), songs, playlists: [mix], nowMs: NOW });
        expect(result.sort()).toEqual(["heard-but-kept", "heard-but-liked", "never"]);
    });
});

describe("mixWeekOf", () => {
    it("reads the funnel's '{base} · {MMM d}' names and nothing else", () => {
        expect(mixWeekOf("Discover Mix · Nov 23", NOW)).toBe(Date.UTC(2026, 10, 23));
        expect(mixWeekOf("New Release Mix · Nov 2", NOW)).toBe(Date.UTC(2026, 10, 2));
        expect(mixWeekOf("Subscriptions", NOW)).toBeUndefined();
        expect(mixWeekOf("Discover Mix · Foo 3", NOW)).toBeUndefined();
        expect(mixWeekOf("Discover Mix · Nov 40", NOW)).toBeUndefined();
    });

    it("puts a December mix in last year once January comes", () => {
        const jan = Date.UTC(2027, 0, 6);
        expect(mixWeekOf("Discover Mix · Dec 28", jan)).toBe(Date.UTC(2026, 11, 28));
        expect(mixWeekOf("Discover Mix · Jan 4", jan)).toBe(Date.UTC(2027, 0, 4));
        expect(mixWeekOf("Discover Mix · Jan 4", jan)! > mixWeekOf("Discover Mix · Dec 28", jan)!).toBe(true);
    });

    it("allows a mix dated a few days ahead (a week named for its Monday, clocks a little off)", () => {
        expect(mixWeekOf("Discover Mix · Nov 30", NOW)).toBe(Date.UTC(2026, 10, 30));
    });
});

describe("isUnheard", () => {
    it("treats no play and the epoch placeholder as never played", () => {
        expect(isUnheard(song("a", { lastPlayedMs: null }))).toBe(true);
        expect(isUnheard(song("a", { lastPlayedMs: 0 }))).toBe(true);
        expect(isUnheard(song("a", { lastPlayedMs: NOW }))).toBe(false);
    });
});

describe("diffAutoDownloads", () => {
    const none = new Map<string, DownloadSource>();

    it("adds what is wanted and neither downloaded nor queued, in wanted order", () => {
        const differences = diffAutoDownloads({
            wanted: ["c", "a", "b"],
            downloaded: new Map([["a", "manual"]]),
            queued: none,
            protectedIds: new Set(),
        });
        expect(differences).toEqual([{ songId: "c", action: "add" }, { songId: "b", action: "add" }]);
    });

    it("removes only auto rows no longer wanted, never a hand-picked one", () => {
        const differences = diffAutoDownloads({
            wanted: [],
            downloaded: new Map<string, DownloadSource>([["auto-done", "auto"], ["mine", "manual"]]),
            queued: new Map<string, DownloadSource>([["auto-queued", "auto"], ["mine-queued", "manual"]]),
            protectedIds: new Set(),
        });
        expect(differences).toEqual([{ songId: "auto-done", action: "remove" }, { songId: "auto-queued", action: "remove" }]);
    });

    it("never removes a song the player has lined up", () => {
        const differences = diffAutoDownloads({
            wanted: [],
            downloaded: new Map([["playing", "auto"]]),
            queued: none,
            protectedIds: new Set(["playing"]),
        });
        expect(differences).toEqual([]);
    });

    it("leaves a song that is the user's on either side alone", () => {
        const differences = diffAutoDownloads({
            wanted: [],
            downloaded: new Map([["a", "manual"]]),
            queued: new Map([["a", "auto"]]),
            protectedIds: new Set(),
        });
        expect(differences).toEqual([]);
    });
});

describe("planReconcile: the 10-minute hold", () => {
    const add: Difference = { songId: "s", action: "add" };
    const remove: Difference = { songId: "s", action: "remove" };

    // Runs the plan the way the reconciler would, applying the pending changes it decides.
    function run(differences: Difference[], pending: PendingDifference[], nowMs: number) {
        const plan = planReconcile({ differences, pending, nowMs });
        const next = new Map(pending.map((x) => [x.songId, x]));
        plan.deletePending.forEach((id) => next.delete(id));
        plan.insertPending.forEach((x) => next.set(x.songId, x));
        return { plan, pending: [...next.values()] };
    }

    it("a new like does nothing at first: it waits", () => {
        const { plan, pending } = run([add], [], NOW);
        expect(plan.enqueue).toEqual([]);
        expect(pending).toEqual([{ songId: "s", action: "add", firstSeenAt: NOW }]);
    });

    it("queues the download once the like has held for the full window, and clears its row", () => {
        let state = run([add], [], NOW);
        state = run([add], state.pending, NOW + 9 * MINUTE);
        expect(state.plan.enqueue).toEqual([]);
        state = run([add], state.pending, NOW + AUTO_DOWNLOAD_DELAY_MS);
        expect(state.plan.enqueue).toEqual(["s"]);
        expect(state.pending).toEqual([]);
    });

    it("a like undone at 5 minutes queues nothing and leaves no trace", () => {
        let state = run([add], [], NOW);
        state = run([], state.pending, NOW + 5 * MINUTE);
        expect(state.plan.enqueue).toEqual([]);
        expect(state.pending).toEqual([]);
        state = run([], state.pending, NOW + 20 * MINUTE);
        expect(state.plan.enqueue).toEqual([]);
    });

    it("a dislike undone in time removes nothing", () => {
        let state = run([remove], [], NOW);
        state = run([], state.pending, NOW + 3 * MINUTE);
        state = run([], state.pending, NOW + 30 * MINUTE);
        expect(state.plan.remove).toEqual([]);
        expect(state.pending).toEqual([]);
    });

    it("removes once the dislike has held for the window", () => {
        let state = run([remove], [], NOW);
        state = run([remove], state.pending, NOW + AUTO_DOWNLOAD_DELAY_MS);
        expect(state.plan.remove).toEqual(["s"]);
    });

    it("a flip starts a new clock: like, un-like, re-like waits a full window from the re-like", () => {
        let state = run([add], [], NOW);
        state = run([], state.pending, NOW + 5 * MINUTE);
        state = run([add], state.pending, NOW + 6 * MINUTE);
        state = run([add], state.pending, NOW + 11 * MINUTE);
        expect(state.plan.enqueue).toEqual([]);
        state = run([add], state.pending, NOW + 16 * MINUTE);
        expect(state.plan.enqueue).toEqual(["s"]);
    });

    it("a difference that turns into its opposite replaces its row with a fresh clock", () => {
        const plan = planReconcile({ differences: [remove], pending: [{ songId: "s", action: "add", firstSeenAt: NOW - 60 * MINUTE }], nowMs: NOW });
        expect(plan.remove).toEqual([]);
        expect(plan.deletePending).toEqual(["s"]);
        expect(plan.insertPending).toEqual([{ songId: "s", action: "remove", firstSeenAt: NOW }]);
    });

    it("with a zero delay (the developer hook) acts at once and writes no row", () => {
        const plan = planReconcile({ differences: [add], pending: [], nowMs: NOW, delayMs: 0 });
        expect(plan).toEqual({ insertPending: [], deletePending: [], enqueue: ["s"], remove: [] });
    });
});

describe("the free-space floor", () => {
    const MB = 1024 * 1024;

    it("lets an auto download start only if it leaves the floor free", () => {
        expect(autoDownloadFits({ freeBytes: 5000 * MB, songBytes: 4 * MB, floorBytes: 4096 * MB })).toBe(true);
        expect(autoDownloadFits({ freeBytes: 4098 * MB, songBytes: 4 * MB, floorBytes: 4096 * MB })).toBe(false);
    });

    it("fails closed when free space can't be read", () => {
        expect(autoDownloadFits({ freeBytes: undefined, songBytes: 1, floorBytes: 0 })).toBe(false);
        expect(autoDownloadFits({ freeBytes: Number.NaN, songBytes: 1, floorBytes: 0 })).toBe(false);
    });
});

describe("fileHashesToDelete", () => {
    it("keeps a file another download still uses (files are named by hash)", () => {
        const removing = [{ songId: "a", fileHash: "h1" }, { songId: "b", fileHash: "h2" }];
        expect(fileHashesToDelete({ removing, keptFileHashes: new Set(["h2"]) })).toEqual(new Set(["h1"]));
    });
});
