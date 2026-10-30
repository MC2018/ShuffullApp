import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import type { GenericDb } from "@/app/services/db/GenericDb";
import { addRequests, getRequests } from "@/app/services/db/queries/request";
import { countMaybeDropSongs, getListenStatsSnapshot, getMaybeDropSongs, getSongListenStat, replaceListenStats } from "@/app/services/db/queries/listenStats";
import { artistTable, songArtistTable, songTable, userSongTable, userTable } from "@/app/services/db/schema";
import type { Song } from "@/app/services/db/models";
import type { ListenStatsResponse, RecordListensResponse } from "@/app/services/api/models";
import type { RecordListenPayload } from "@/app/services/db/models";
import { LikeStatus, RequestType } from "@/app/enums";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import {
    LISTEN_STATS_MIN_GAP_MS,
    LISTEN_STATS_REFRESH_MS,
    describeAgo,
    describeMaybeDropRow,
    describeMaybeDropRule,
    describeQuickSkips,
    formatListenTime,
    listenStatFacts,
    listenStatsDue,
} from "@/app/tools/listenStats";

vi.mock("@/app/tools", () => import("@/app/tools/pure"));
vi.mock("@/app/services/downloader/Downloader", () => ({ Downloader: {} }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => {} } }));

const { SyncManager } = await import("@/app/services/sync-manager/SyncManager");

const USER = "u1";
const RULE = { skippedUnderSeconds: 30, quickSkips: 3, ofLastPlays: 5 };

function makeDb(): GenericDb {
    const db = drizzle(new Database(":memory:"));
    migrate(db, { migrationsFolder: path.resolve(__dirname, "../app/services/db/drizzle") });
    return db as unknown as GenericDb;
}

function song(id: string): Song {
    return {
        songId: id, fileExtension: ".mp3", fileHash: `hash-${id}`, name: `Song ${id}`,
        syncedLyrics: null, plainLyrics: null, lyricsInstrumental: false, lyricsSource: null,
        bpm: null, heaviness: null, exploratory: false, tagsStale: false, hookStartPercent: null,
    };
}

type StatRow = ListenStatsResponse["songs"][number];
function stat(songId: string, over: Partial<StatRow> = {}): StatRow {
    return {
        songId, plays: 5, skips: 3, averageSecondsListened: 40, completionPercent: 20,
        lastPlayed: new Date("2026-10-30T12:00:00Z"), recentQuickSkips: 3, maybeDrop: true, ...over,
    };
}

describe("listenStatsDue", () => {
    const now = 10 * LISTEN_STATS_REFRESH_MS;

    it("asks on the first sync, then once per interval", () => {
        expect(listenStatsDue(null, now, false)).toBe(true);
        expect(listenStatsDue({ at: now - 1000, ok: true }, now, false)).toBe(false);
        expect(listenStatsDue({ at: now - LISTEN_STATS_REFRESH_MS, ok: true }, now, false)).toBe(true);
        expect(listenStatsDue({ at: now - LISTEN_STATS_REFRESH_MS, ok: false }, now, false)).toBe(true);
    });

    it("asks sooner after this device sent listens, but not within the minimum gap", () => {
        expect(listenStatsDue({ at: now - LISTEN_STATS_MIN_GAP_MS, ok: true }, now, true)).toBe(true);
        expect(listenStatsDue({ at: now - LISTEN_STATS_MIN_GAP_MS + 1, ok: true }, now, true)).toBe(false);
    });

    it("doesn't ask a server without the endpoint again after every song", () => {
        expect(listenStatsDue({ at: now - LISTEN_STATS_MIN_GAP_MS, ok: false }, now, true)).toBe(false);
    });

    it("asks again when the clock went backwards", () => {
        expect(listenStatsDue({ at: now + 5000, ok: true }, now, false)).toBe(true);
    });
});

describe("listen stats wording", () => {
    it("formats durations", () => {
        expect(formatListenTime(0)).toBe("0:00");
        expect(formatListenTime(151.25)).toBe("2:31");
        expect(formatListenTime(3725)).toBe("1:02:05");
    });

    it("says how long ago", () => {
        const now = new Date("2026-10-31T12:00:00Z");
        expect(describeAgo(new Date("2026-10-31T11:59:30Z"), now)).toBe("just now");
        expect(describeAgo(new Date("2026-10-31T11:55:00Z"), now)).toBe("5 min ago");
        expect(describeAgo(new Date("2026-10-31T09:00:00Z"), now)).toBe("3 h ago");
        expect(describeAgo(new Date("2026-10-30T12:00:00Z"), now)).toBe("1 day ago");
        expect(describeAgo(new Date("2026-10-28T12:00:00Z"), now)).toBe("3 days ago");
    });

    it("puts the server's rule and counts into words", () => {
        expect(describeMaybeDropRule(RULE)).toBe("Skipped in under 30 s on 3 of the last 5 plays.");
        expect(describeQuickSkips({ plays: 12, recentQuickSkips: 4 }, RULE)).toBe("4 of your last 5 plays skipped in under 30 s");
        expect(describeQuickSkips({ plays: 3, recentQuickSkips: 3 }, RULE)).toBe("3 of your last 3 plays skipped in under 30 s");
    });

    it("words the Library row before the first sync, with none flagged, and with some", () => {
        expect(describeMaybeDropRow(null)).toBe("Songs you keep skipping early");
        expect(describeMaybeDropRow(0)).toBe("No songs flagged");
        expect(describeMaybeDropRow(1)).toBe("1 song you keep skipping early");
        expect(describeMaybeDropRow(2)).toBe("2 songs you keep skipping early");
    });

    it("lists the song screen's facts, with a dash when completion is unknown", () => {
        const now = new Date("2026-10-31T12:00:00Z");
        const facts = listenStatFacts({ ...stat("s1", { plays: 12, skips: 4, averageSecondsListened: 151.25, completionPercent: 70.5 }), userId: USER }, now);
        expect(facts).toEqual([
            { label: "Plays", value: "12" },
            { label: "Skips", value: "4" },
            { label: "Average listened", value: "2:31" },
            { label: "Completion", value: "71%" },
            { label: "Last played", value: "1 day ago" },
        ]);
        expect(listenStatFacts({ ...stat("s1", { completionPercent: null }), userId: USER }, now)[3].value).toBe("—");
    });
});

describe("listen stats cache", () => {
    let db: GenericDb;
    beforeEach(async () => {
        db = makeDb();
        await db.insert(songTable).values(["a", "b", "c", "d"].map(song));
        await db.insert(artistTable).values([{ artistId: "x", name: "Xavier" }, { artistId: "y", name: "Yara" }]);
        await db.insert(songArtistTable).values([
            { songArtistId: "sa1", songId: "a", artistId: "y" },
            { songArtistId: "sa2", songId: "a", artistId: "x" },
            { songArtistId: "sa3", songId: "b", artistId: "x" },
        ]);
    });

    it("is empty and unsynced until the first refresh", async () => {
        expect(await getListenStatsSnapshot(db, USER)).toBeNull();
        expect(await getSongListenStat(db, USER, "a")).toBeNull();
        expect(await getMaybeDropSongs(db, USER)).toEqual([]);
        expect(await countMaybeDropSongs(db, USER)).toBe(0);
    });

    it("replaces the whole cache and the rule on each refresh", async () => {
        await replaceListenStats(db, USER, { maybeDropRule: RULE, songs: [stat("a"), stat("b")] }, new Date(1000));
        await replaceListenStats(db, USER,
            { maybeDropRule: { ...RULE, quickSkips: 4 }, songs: [stat("b", { plays: 9 })] }, new Date(2000));

        expect(await getListenStatsSnapshot(db, USER)).toEqual({ syncedAt: new Date(2000), rule: { ...RULE, quickSkips: 4 } });
        expect(await getSongListenStat(db, USER, "a")).toBeNull();
        expect((await getSongListenStat(db, USER, "b"))?.plays).toBe(9);
    });

    it("keeps each user's stats apart", async () => {
        await replaceListenStats(db, USER, { maybeDropRule: RULE, songs: [stat("a")] }, new Date(1000));
        await replaceListenStats(db, "u2", { maybeDropRule: RULE, songs: [] }, new Date(2000));

        expect(await getSongListenStat(db, USER, "a")).not.toBeNull();
        expect(await getListenStatsSnapshot(db, "u2")).toEqual({ syncedAt: new Date(2000), rule: RULE });
    });

    it("lists flagged songs only, most quick skips first, with their artists", async () => {
        await replaceListenStats(db, USER, {
            maybeDropRule: RULE,
            songs: [
                stat("a", { recentQuickSkips: 3, lastPlayed: new Date("2026-10-30T00:00:00Z") }),
                stat("b", { recentQuickSkips: 5 }),
                stat("c", { recentQuickSkips: 3, lastPlayed: new Date("2026-10-31T00:00:00Z") }),
                stat("d", { recentQuickSkips: 1, maybeDrop: false }),
                stat("not-on-device", { recentQuickSkips: 5 }),
            ],
        }, new Date());

        const list = await getMaybeDropSongs(db, USER);

        expect(list.map(x => x.song.songId)).toEqual(["b", "c", "a"]);
        expect(list[2].artists.map(x => x.name)).toEqual(["Xavier", "Yara"]);
        expect(list[1].artists).toEqual([]);
        expect(list[0].stat.recentQuickSkips).toBe(5);
        expect(await countMaybeDropSongs(db, USER)).toBe(3);
    });

    it("leaves out a flagged song the user already disliked", async () => {
        await db.insert(userTable).values([USER, "u2"].map(userId => ({ userId, username: userId, version: new Date() })));
        await db.insert(userSongTable).values([
            { userId: USER, songId: "a", lastPlayed: new Date(), version: new Date(), likeStatus: LikeStatus.Dislike },
            { userId: USER, songId: "b", lastPlayed: new Date(), version: new Date(), likeStatus: LikeStatus.Like },
            { userId: "u2", songId: "c", lastPlayed: new Date(), version: new Date(), likeStatus: LikeStatus.Dislike },
        ]);
        await replaceListenStats(db, USER, { maybeDropRule: RULE, songs: [stat("a"), stat("b"), stat("c")] }, new Date());

        expect((await getMaybeDropSongs(db, USER)).map(x => x.song.songId).sort()).toEqual(["b", "c"]);
        expect(await countMaybeDropSongs(db, USER)).toBe(2);
    });
});

describe("SyncManager: refreshing listen stats", () => {
    let db: GenericDb;
    beforeEach(() => {
        db = makeDb();
    });

    function makeApi(listenStats: () => Promise<ListenStatsResponse>) {
        return {
            listenStats: vi.fn(listenStats),
            listenRecord: vi.fn(async (listens: RecordListenPayload[]): Promise<RecordListensResponse> => ({
                results: listens.map(x => ({ listenId: x.listenId, outcome: "recorded", error: null })),
            })),
            songGetList: vi.fn(async () => []),
        };
    }

    function makeManager(api: ReturnType<typeof makeApi>) {
        const manager = Object.create(SyncManager.prototype);
        Object.assign(manager, {
            db, api, userId: USER, logout: vi.fn(async () => {}), syncing: false, keepRetriedAt: new Map(),
            failedSyncs: 0, ticksToSkip: 0, listenStatsAttempt: null,
        });
        manager.overallSync = vi.fn(async () => 200);
        return manager as { sync(): Promise<void>; failedSyncs: number; listenStatsAttempt: { at: number; ok: boolean } | null };
    }

    async function queueListen(listenId: string) {
        await addRequests(db, [{
            requestId: `listen-${listenId}`,
            timeRequested: new Date(),
            requestType: RequestType.RecordListen,
            userId: USER,
            payload: { listenId } as unknown as RecordListenPayload,
        }]);
    }

    it("caches the server's stats after a good sync", async () => {
        const api = makeApi(async () => ({ maybeDropRule: RULE, songs: [stat("a")] }));
        const manager = makeManager(api);

        await manager.sync();

        expect(api.listenStats).toHaveBeenCalledTimes(1);
        expect((await getSongListenStat(db, USER, "a"))?.maybeDrop).toBe(true);
        expect(await getListenStatsSnapshot(db, USER)).not.toBeNull();
    });

    it("a server without the endpoint (404) fails nothing, drops nothing and keeps the last stats", async () => {
        await replaceListenStats(db, USER, { maybeDropRule: RULE, songs: [stat("a")] }, new Date(1000));
        await queueListen("l1");
        const api = makeApi(async () => {
            throw new ApiStatusFailureError("/api/v1/listens/stats", { status: 404, data: "" });
        });
        const warn = vi.spyOn(console, "warn");
        const error = vi.spyOn(console, "error");
        const manager = makeManager(api);

        await manager.sync();

        expect(api.listenStats).toHaveBeenCalledTimes(1);
        expect(manager.failedSyncs).toBe(0);
        expect(manager.listenStatsAttempt?.ok).toBe(false);
        expect(api.listenRecord).toHaveBeenCalledTimes(1);
        expect(await getRequests(db, USER)).toEqual([]);
        expect(await getListenStatsSnapshot(db, USER)).toEqual({ syncedAt: new Date(1000), rule: RULE });
        expect(await getSongListenStat(db, USER, "a")).not.toBeNull();
        // Quiet: no warning or error, so no LogBox toast after every sync.
        expect(warn.mock.calls.filter(c => String(c[0]).includes("listen stats"))).toEqual([]);
        expect(error.mock.calls.filter(c => String(c[0]).includes("listen stats"))).toEqual([]);

        // Nor is it asked again on the next sync, even with new listens.
        await queueListen("l2");
        await manager.sync();
        expect(api.listenStats).toHaveBeenCalledTimes(1);
    });

    it("a malformed answer leaves the cache as it was", async () => {
        await replaceListenStats(db, USER, { maybeDropRule: RULE, songs: [stat("a")] }, new Date(1000));
        const api = makeApi(async () => { throw new Error("zod: songs expected array"); });
        const manager = makeManager(api);

        await manager.sync();

        expect(manager.failedSyncs).toBe(0);
        expect(await getSongListenStat(db, USER, "a")).not.toBeNull();
    });

    it("waits out the interval, unless this device just sent listens", async () => {
        const api = makeApi(async () => ({ maybeDropRule: RULE, songs: [] }));
        const manager = makeManager(api);

        await manager.sync();
        await manager.sync();
        expect(api.listenStats).toHaveBeenCalledTimes(1);

        manager.listenStatsAttempt = { at: Date.now() - LISTEN_STATS_MIN_GAP_MS, ok: true };
        await queueListen("l1");
        await manager.sync();
        expect(api.listenStats).toHaveBeenCalledTimes(2);
    });
});
