import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLogLine, log, LogLevel } from "@/app/tools/log";

// ShuffullApp#168: every app log line goes through log, and `./scripts/android-dev.sh logs` (logcat, every priority
// of the ReactNativeJS tag) is read by grepping the tag. So a line must come out exactly as the console call it
// replaced wrote it: "[tag] message", then the details untouched.
describe("log", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("writes the tag in brackets before the message", () => {
        expect(formatLogLine("API", "Calling endpoint: /api/v1/songs")).toBe("[API] Calling endpoint: /api/v1/songs");
        expect(formatLogLine("sync", "Sync failed:")).toBe("[sync] Sync failed:");
    });

    for (const level of ["debug", "info", "warn", "error"] as const satisfies readonly LogLevel[]) {
        it(`log.${level} writes through console.${level} and passes the details on as they are`, () => {
            const spies = Object.fromEntries((["debug", "log", "info", "warn", "error"] as const)
                .map(l => [l, vi.spyOn(console, l).mockImplementation(() => undefined)]));
            const error = new Error("boom");
            const detail = { songId: "s1" };

            log[level]("sync", "Holding 2 request(s).", error, detail);

            expect(spies[level]).toHaveBeenCalledExactlyOnceWith("[sync] Holding 2 request(s).", error, detail);
            for (const [other, spy] of Object.entries(spies)) {
                if (other !== level) {
                    expect(spy).not.toHaveBeenCalled();
                }
            }
        });
    }

    it("writes the same line the [API] console.log call it replaced did", () => {
        const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
        const label = "/api/v1/songs/changed";

        log.info("API", `Endpoint ${label} succeeded`);

        expect(info.mock.calls[0]).toEqual([`[API] Endpoint ${label} succeeded`]);
        expect(String(info.mock.calls[0][0])).toMatch(/^\[API\] /);
    });

    it("looks the console method up on each call, so a spy set after import still sees the line", () => {
        const first = vi.fn();
        const second = vi.fn();
        vi.spyOn(console, "warn").mockImplementation(first);
        log.warn("player", "one");
        vi.spyOn(console, "warn").mockImplementation(second);
        log.warn("player", "two");

        expect(first.mock.calls).toEqual([["[player] one"]]);
        expect(second.mock.calls).toEqual([["[player] two"]]);
    });
});
