import { describe, it, expect } from "vitest";
import { LikeStatus } from "@/app/enums";
import { auditionProgress, auditionScopePlaylistId, deriveAuditionRowState, hasBeenPlayed, isAuditionComplete, shouldStopForFinishedAudition } from "@/app/tools/audition";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";

// The four-state row derivation for audition playlists, computed entirely from synced fields so it is
// identical across devices: unheard (dot) / heard incl. disliked (dimmed) / kept (bookmark) / liked (heart).
describe("deriveAuditionRowState", () => {
    const played = new Date("2026-07-20T12:00:00Z");

    it("likes and loves render as liked, regardless of anything else", () => {
        expect(deriveAuditionRowState(true, LikeStatus.Like, null)).toBe("liked");
        expect(deriveAuditionRowState(false, LikeStatus.Love, played)).toBe("liked");
    });

    it("a dislike is a verdict: heard (dimmed), even at zero seconds played", () => {
        expect(deriveAuditionRowState(true, LikeStatus.Dislike, null)).toBe("heard");
    });

    it("a non-exploratory undecided song in an audition view was Kept", () => {
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, played)).toBe("kept");
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, null)).toBe("kept");
    });

    it("an exploratory song splits on whether it has ever been played", () => {
        expect(deriveAuditionRowState(true, LikeStatus.Neutral, played)).toBe("heard");
        expect(deriveAuditionRowState(true, LikeStatus.Neutral, null)).toBe("unheard");
    });

    it("server-seeded DateTime.MinValue lastPlayed does not count as played", () => {
        // The site seeds UserSong.LastPlayed = DateTime.MinValue (year 1), far before the epoch.
        const minValue = new Date(-62135596800000);
        expect(hasBeenPlayed(minValue)).toBe(false);
        expect(deriveAuditionRowState(true, LikeStatus.Neutral, minValue)).toBe("unheard");
    });
});

describe("auditionProgress", () => {
    it("counts everything but unheard as evaluated", () => {
        const progress = auditionProgress(["unheard", "heard", "kept", "liked", "unheard"]);
        expect(progress).toEqual({ evaluated: 3, total: 5 });
    });

    it("empty cohort is 0/0", () => {
        expect(auditionProgress([])).toEqual({ evaluated: 0, total: 0 });
    });
});

describe("row state outside an audition playlist", () => {
    const played = new Date(1_700_000_000_000);
    const never = new Date(0);

    it("reports unheard for a never-played song in an ordinary playlist", () => {
        // The bug: songs in Classic Rock / YouTube Liked are not exploratory, so the "kept" shortcut claimed
        // every one of them had been evaluated - and "Unheard only" filtered the list to nothing.
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, never, false)).toBe("unheard");
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, null, false)).toBe("unheard");
    });

    it("reports heard once an ordinary-playlist song has been played", () => {
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, played, false)).toBe("heard");
    });

    it("still honours a verdict outside an audition playlist", () => {
        expect(deriveAuditionRowState(false, LikeStatus.Like, never, false)).toBe("liked");
        expect(deriveAuditionRowState(false, LikeStatus.Love, played, false)).toBe("liked");
        expect(deriveAuditionRowState(false, LikeStatus.Dislike, never, false)).toBe("heard");
    });

    it("never reports kept outside an audition playlist", () => {
        // "kept" only means something where the Keep button exists.
        for (const status of [LikeStatus.Neutral, LikeStatus.Like, LikeStatus.Love, LikeStatus.Dislike]) {
            for (const last of [never, played, null]) {
                expect(deriveAuditionRowState(false, status, last, false)).not.toBe("kept");
                expect(deriveAuditionRowState(true, status, last, false)).not.toBe("kept");
            }
        }
    });

    it("leaves audition behaviour unchanged", () => {
        // The default keeps existing callers (the library cohort bubbles) on the audition semantics.
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, played)).toBe("kept");
        expect(deriveAuditionRowState(false, LikeStatus.Neutral, played, true)).toBe("kept");
        expect(deriveAuditionRowState(true, LikeStatus.Neutral, never, true)).toBe("unheard");
    });

    it("makes progress meaningful on an ordinary playlist", () => {
        // Previously every row was "kept" => 100% evaluated on day one, which told the user nothing.
        const rows = [
            deriveAuditionRowState(false, LikeStatus.Neutral, never, false),
            deriveAuditionRowState(false, LikeStatus.Neutral, played, false),
            deriveAuditionRowState(false, LikeStatus.Like, played, false),
        ];
        expect(auditionProgress(rows)).toEqual({ evaluated: 2, total: 3 });
    });
});

describe("auditionScopePlaylistId", () => {
    it("identifies the audition play scope: a sole playlist with unheardOnly", () => {
        const scope = new SongFilters();
        scope.setSoleFilter(SongFilterType.Playlist, ["mix"]);
        scope.unheardOnly = true;
        expect(auditionScopePlaylistId(scope)).toBe("mix");
    });

    it("is undefined for an ordinary playlist scope and for whole-library shuffle", () => {
        const playlist = new SongFilters();
        playlist.setSoleFilter(SongFilterType.Playlist, ["classic-rock"]);
        expect(auditionScopePlaylistId(playlist)).toBeUndefined();
        expect(auditionScopePlaylistId(new SongFilters())).toBeUndefined();
    });
});

describe("shouldStopForFinishedAudition", () => {
    const done = { evaluated: 110, total: 110 };
    const notDone = { evaluated: 109, total: 110 };

    it("stops when the mix that was unfinished at the song's start is now complete", () => {
        expect(shouldStopForFinishedAudition("mix", "mix", done)).toBe(true);
    });

    it("plays on while songs are left, or when the mix was already done at the start", () => {
        expect(shouldStopForFinishedAudition("mix", "mix", notDone)).toBe(false);
        expect(shouldStopForFinishedAudition(undefined, "mix", done)).toBe(false);
    });

    it("plays on once the scope is something else, or the mix has gone", () => {
        expect(shouldStopForFinishedAudition("mix", undefined, done)).toBe(false);
        expect(shouldStopForFinishedAudition("mix", "other-mix", done)).toBe(false);
        expect(shouldStopForFinishedAudition("mix", "mix", undefined)).toBe(false);
    });

    it("an empty mix is never complete", () => {
        expect(isAuditionComplete({ evaluated: 0, total: 0 })).toBe(false);
    });
});
