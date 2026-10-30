import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import type { ApiClient } from "@/app/services/api/ApiClient";
import type { Recap } from "@/app/services/api/models";
import { failureLoad, loadRecap, readSavedRecap } from "@/app/services/recap/recapLoader";
import { sampleRecap } from "@/app/services/recap/sampleRecap";
import {
    busiestHour,
    formatLocalDay,
    formatMinutes,
    isRecapSeason,
    offsetTimeZone,
    recapButtonVisible,
    recapCacheKey,
    recapYear,
    scaleToMax,
    statsStartedLine,
} from "@/app/tools/recap";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
    default: {
        getItem: async (key: string) => storage.get(key) ?? null,
        setItem: async (key: string, value: string) => {
            storage.set(key, value);
        },
    },
}));

// Local-time constructors on purpose: the window is 1 to 31 December on the device's own calendar.
describe("the December recap window (ShuffullApp#116)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("is hidden at 23:59 on 30 November", () => {
        vi.setSystemTime(new Date(2026, 10, 30, 23, 59));
        expect(isRecapSeason()).toBe(false);
        expect(recapButtonVisible(new Date(), 10)).toBe(false);
    });

    it("shows from 00:00 on 1 December, for that year", () => {
        vi.setSystemTime(new Date(2026, 11, 1, 0, 0));
        expect(isRecapSeason()).toBe(true);
        expect(recapButtonVisible(new Date(), 10)).toBe(true);
        expect(recapYear()).toBe(2026);
    });

    it("still shows at 23:59 on 31 December", () => {
        vi.setSystemTime(new Date(2026, 11, 31, 23, 59));
        expect(recapButtonVisible(new Date(), 1)).toBe(true);
    });

    it("is hidden again at 00:00 on 1 January", () => {
        vi.setSystemTime(new Date(2027, 0, 1, 0, 0));
        expect(isRecapSeason()).toBe(false);
        expect(recapButtonVisible(new Date(), 10)).toBe(false);
    });

    it("stays hidden in December for a user with no listens that year, or none known yet", () => {
        const december = new Date(2026, 11, 10, 12, 0);
        expect(recapButtonVisible(december, 0)).toBe(false);
        expect(recapButtonVisible(december, null)).toBe(false);
        expect(recapButtonVisible(december, undefined)).toBe(false);
    });
});

describe("the stats-started line", () => {
    const year = { from: new Date("2026-01-01T05:00:00Z"), to: new Date("2027-01-01T05:00:00Z") };

    it("says when stats started, for a first year that began part-way through", () => {
        const line = statsStartedLine({ ...year, firstListen: new Date(2026, 2, 14, 18, 22) });
        expect(line).toBe("Your stats started on 14 March 2026, with your first recorded listen. Nothing before that was counted.");
    });

    it("is absent for a full year, whose first listen came before it", () => {
        expect(statsStartedLine({ ...year, firstListen: new Date("2025-06-01T00:00:00Z") })).toBeNull();
    });

    it("never claims a start outside the year: `to` is exclusive, and a millisecond before `from` is a full year", () => {
        expect(statsStartedLine({ ...year, firstListen: year.to })).toBeNull();
        expect(statsStartedLine({ ...year, firstListen: new Date(year.from.getTime() - 1) })).toBeNull();
    });

    it("is absent when the API doesn't say (null, or an API older than Shuffull#104)", () => {
        expect(statsStartedLine({ ...year, firstListen: null })).toBeNull();
        expect(statsStartedLine({ ...year, firstListen: undefined })).toBeNull();
    });

    it("shows for the dev sample, which starts in March", () => {
        // The day is the device's local one, so it depends on the zone the tests run in.
        expect(statsStartedLine(sampleRecap())).toMatch(/^Your stats started on 1[45] March 2026/);
    });
});

describe("recap wording", () => {
    it("formats minutes as a summary", () => {
        expect(formatMinutes(0.4)).toBe("0 min");
        expect(formatMinutes(45)).toBe("45 min");
        expect(formatMinutes(60)).toBe("1 h");
        expect(formatMinutes(125)).toBe("2 h 5 min");
        expect(formatMinutes(100 * 60 + 17)).toBe("100 h");
        expect(formatMinutes(1234 * 60)).toBe("1,234 h");
    });

    it("writes a device offset the way the API's time zone parser reads it", () => {
        expect(offsetTimeZone(300)).toBe("-05:00");
        expect(offsetTimeZone(-120)).toBe("+02:00");
        expect(offsetTimeZone(-330)).toBe("+05:30");
        expect(offsetTimeZone(0)).toBe("+00:00");
    });

    it("reads a streak's local days without shifting them through UTC", () => {
        expect(formatLocalDay("2026-11-02")).toBe("2 November");
        expect(formatLocalDay("2026-01-01")).toBe("1 January");
    });

    it("finds the busiest hour, and none in an empty year", () => {
        const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
        expect(busiestHour(heatmap)).toBeNull();
        heatmap[5][21] = 30;
        heatmap[0][9] = 12;
        expect(busiestHour(heatmap)).toEqual({ day: 5, hour: 21, minutes: 30 });
    });

    it("scales bars to the largest, leaving an empty chart empty", () => {
        expect(scaleToMax([0, 5, 10])).toEqual([0, 0.5, 1]);
        expect(scaleToMax([0, 0])).toEqual([0, 0]);
    });
});

describe("loading the recap", () => {
    beforeEach(() => {
        storage.clear();
    });

    const apiReturning = (result: () => Promise<Recap>) => ({ recapGet: vi.fn(result) }) as unknown as ApiClient;

    it("says quietly that the recap isn't ready when the API has no recap endpoint (404)", async () => {
        const api = apiReturning(() => Promise.reject(new ApiStatusFailureError("/api/v1/recap/2026", { status: 404 })));
        expect(await loadRecap(api, "user-1", 2026, "UTC")).toEqual({ status: "unavailable" });
    });

    it("tells offline apart from a server error", () => {
        expect(failureLoad(404)).toEqual({ status: "unavailable" });
        expect(failureLoad(503)).toEqual({ status: "offline" });
        expect(failureLoad(500)).toEqual({ status: "error", httpStatus: 500 });
    });

    it("saves a fetched recap per user and year, and shows it when a later fetch fails", async () => {
        const recap = sampleRecap();
        const ok = apiReturning(() => Promise.resolve(recap));
        const first = await loadRecap(ok, "user-1", 2026, "America/New_York");
        expect(first).toMatchObject({ status: "ready", saved: false });
        expect(storage.has(recapCacheKey("user-1", 2026))).toBe(true);
        expect(ok.recapGet).toHaveBeenCalledWith(2026, "America/New_York");

        const down = apiReturning(() => Promise.reject(new ApiStatusFailureError("/api/v1/recap/2026", { status: 503 })));
        const second = await loadRecap(down, "user-1", 2026, "America/New_York");
        expect(second).toMatchObject({ status: "ready", saved: true });
        if (second.status === "ready") {
            expect(second.recap.plays).toBe(recap.plays);
            expect(second.recap.firstListen).toEqual(recap.firstListen);
        }

        // Another user, or another year, doesn't see that copy.
        expect(await loadRecap(down, "user-2", 2026, "UTC")).toEqual({ status: "offline" });
        expect(await readSavedRecap("user-1", 2025)).toBeNull();
    });

    it("ignores a saved copy that no longer parses", async () => {
        storage.set(recapCacheKey("user-1", 2026), JSON.stringify({ fetchedAt: 1, recap: { year: "nope" } }));
        expect(await readSavedRecap("user-1", 2026)).toBeNull();
        storage.set(recapCacheKey("user-1", 2026), "not json");
        expect(await readSavedRecap("user-1", 2026)).toBeNull();
    });
});
