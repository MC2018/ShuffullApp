import { describe, expect, it } from "vitest";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import type { DeletedSong, DeletedSongsPage } from "@/app/services/api/models";
import {
    MAX_DELETED_PAGES,
    describeDeletedDate,
    describeDeletedSong,
    describeDeletedSongsCutOff,
    describeDeletedSongsFailure,
    filterDeletedSongs,
    loadAllDeletedSongs,
    youtubeWatchUrl,
} from "@/app/tools/deletedSongs";

const song = (songId: string, extra: Partial<DeletedSong> = {}): DeletedSong => ({
    songId,
    name: `Song ${songId}`,
    artistNames: null,
    externalSongId: null,
    playlistName: null,
    deletedAt: new Date(2026, 9, 22, 12, 0, 0),
    ...extra,
});

describe("loadAllDeletedSongs (ShuffullApp#59)", () => {
    it("follows the cursor to the last page, in order", async () => {
        const pages: Record<string, DeletedSongsPage> = {
            first: { songs: [song("a"), song("b")], nextBefore: "c1" },
            c1: { songs: [song("c")], nextBefore: "c2" },
            c2: { songs: [song("d")], nextBefore: null },
        };
        const asked: (string | undefined)[] = [];

        const { songs, complete } = await loadAllDeletedSongs(async (before) => {
            asked.push(before);
            return pages[before ?? "first"];
        });

        expect(songs.map((s) => s.songId)).toEqual(["a", "b", "c", "d"]);
        expect(asked).toEqual([undefined, "c1", "c2"]);
        expect(complete).toBe(true);
    });

    it("stops when the server repeats the cursor it was given, and says the list isn't complete", async () => {
        let calls = 0;
        const { songs, complete } = await loadAllDeletedSongs(async (before) => {
            calls++;
            return { songs: [song(`s${calls}`)], nextBefore: before ?? "same" };
        });

        expect(calls).toBe(2);
        expect(songs).toHaveLength(2);
        expect(complete).toBe(false);
    });

    it("stops after the page cap, keeps what it read, and says the list is cut off", async () => {
        let calls = 0;
        const { songs, complete } = await loadAllDeletedSongs(async () => {
            calls++;
            return { songs: [song(`s${calls}`)], nextBefore: `c${calls}` };
        });

        expect(calls).toBe(MAX_DELETED_PAGES);
        expect(songs).toHaveLength(MAX_DELETED_PAGES);
        expect(songs[0].songId).toBe("s1");
        expect(complete).toBe(false);
    });

    it("is complete when the last page lands exactly on the cap", async () => {
        let calls = 0;
        const { complete } = await loadAllDeletedSongs(async () => {
            calls++;
            return { songs: [song(`s${calls}`)], nextBefore: calls === MAX_DELETED_PAGES ? null : `c${calls}` };
        });

        expect(calls).toBe(MAX_DELETED_PAGES);
        expect(complete).toBe(true);
    });

    it("passes a failure through", async () => {
        await expect(loadAllDeletedSongs(async () => { throw new Error("down"); })).rejects.toThrow("down");
    });
});

describe("describeDeletedSongsCutOff", () => {
    it("says how many were loaded and that older ones aren't shown or searched", () => {
        expect(describeDeletedSongsCutOff(25000))
            .toBe("The list stops at your newest 25,000 deleted songs. Older ones aren't shown or searched.");
        expect(describeDeletedSongsCutOff(1)).toBe("The list stops at your newest 1 deleted song. Older ones aren't shown or searched.");
    });
});

describe("filterDeletedSongs", () => {
    const songs = [
        song("1", { name: "Everybody Wants You", artistNames: "Billy Squier" }),
        song("2", { name: "Untitled", playlistName: "Audition · week of Oct 20" }),
        song("3", { name: "Other" }),
    ];

    it("keeps everything for empty or blank text", () => {
        expect(filterDeletedSongs(songs, "  ")).toBe(songs);
    });

    it("matches name, artists and mix, ignoring case", () => {
        expect(filterDeletedSongs(songs, "everybody").map((s) => s.songId)).toEqual(["1"]);
        expect(filterDeletedSongs(songs, "SQUIER").map((s) => s.songId)).toEqual(["1"]);
        expect(filterDeletedSongs(songs, "oct 20").map((s) => s.songId)).toEqual(["2"]);
        expect(filterDeletedSongs(songs, "nothing")).toEqual([]);
    });
});

describe("youtubeWatchUrl", () => {
    it("links a YouTube video id", () => {
        expect(youtubeWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(youtubeWatchUrl("a-b_c-d_e-f")).toBe("https://www.youtube.com/watch?v=a-b_c-d_e-f");
    });

    it("gives null for no id, or one that isn't a YouTube video id", () => {
        expect(youtubeWatchUrl(null)).toBeNull();
        expect(youtubeWatchUrl("")).toBeNull();
        expect(youtubeWatchUrl("spotify:track:1")).toBeNull();
        expect(youtubeWatchUrl("dQw4w9WgXcQ&x=1")).toBeNull();
    });
});

describe("describeDeletedSong", () => {
    const now = new Date(2026, 10, 13, 9, 0, 0);

    it("shows artists, date and mix", () => {
        expect(describeDeletedSong(song("1", { artistNames: "Billy Squier, Burnard", playlistName: "Audition · week of Oct 20" }), now))
            .toBe("Billy Squier, Burnard · deleted Oct 22 · from Audition · week of Oct 20");
    });

    it("leaves out the mix and names an unknown artist on an old record", () => {
        expect(describeDeletedSong(song("1"), now)).toBe("Unknown Artist · deleted Oct 22");
    });

    it("adds the year only when it isn't this year", () => {
        expect(describeDeletedDate(new Date(2025, 0, 5, 12), now)).toBe("Jan 5, 2025");
        expect(describeDeletedDate(new Date(2026, 0, 5, 12), now)).toBe("Jan 5");
    });
});

describe("describeDeletedSongsFailure", () => {
    const failure = (status: number) => new ApiStatusFailureError("/api/v1/songs/deleted", { status });

    it("says an older server doesn't have the list", () => {
        expect(describeDeletedSongsFailure(failure(404))).toMatch(/doesn't keep a list/);
    });

    it("says when the server can't be reached", () => {
        expect(describeDeletedSongsFailure(failure(503))).toMatch(/Can't reach the server/);
        expect(describeDeletedSongsFailure(failure(530))).toMatch(/Can't reach the server/);
    });

    it("names any other status", () => {
        expect(describeDeletedSongsFailure(failure(500))).toMatch(/error 500/);
    });
});
