import { describe, expect, it } from "vitest";
import { formatInstalledBuild } from "../app/tools/appVersion";

describe("formatInstalledBuild", () => {
    it("names the app, the commit it was built from and the build number", () => {
        expect(formatInstalledBuild({ appName: "Shuffull Dev", version: "1.0.0+abc1234", build: "412" })).toBe(
            "Shuffull Dev · 1.0.0+abc1234 (412)",
        );
    });

    it("keeps the -dirty marker, so a build from uncommitted code is never mistaken for that commit", () => {
        expect(formatInstalledBuild({ appName: "Shuffull", version: "1.0.0+abc1234-dirty", build: "412" })).toBe(
            "Shuffull · 1.0.0+abc1234-dirty (412)",
        );
    });

    it("still shows the version when the name or build number is missing", () => {
        expect(formatInstalledBuild({ appName: null, version: "1.0.0+abc1234", build: "412" })).toBe("1.0.0+abc1234 (412)");
        expect(formatInstalledBuild({ appName: "Shuffull", version: "1.0.0+abc1234", build: null })).toBe("Shuffull · 1.0.0+abc1234");
    });

    it("shows nothing without a native version (web and desktop)", () => {
        expect(formatInstalledBuild({ appName: null, version: null, build: null })).toBeNull();
        expect(formatInstalledBuild({ appName: "Shuffull", version: "", build: "1" })).toBeNull();
    });
});
