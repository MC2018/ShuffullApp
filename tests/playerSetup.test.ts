import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { playerSetupOptions } from "@/app/tools/playerSetup";

// mediaManager imports native modules and can't load here, so its call site is checked as text.
const mediaManagerSource = readFileSync(
    path.resolve(__dirname, "../app/services/media-manager/mediaManager.ts"),
    "utf8",
);

describe("player setup (ShuffullApp#23)", () => {
    it("turns on interruption handling on Android, which the RNTP fork reads as off when the key is missing", () => {
        expect(playerSetupOptions("android").autoHandleInterruptions).toBe(true);
    });

    it("leaves it off on iOS, where it would resume a song the user had paused before a call", () => {
        expect(playerSetupOptions("ios").autoHandleInterruptions).toBe(false);
    });

    it("is what the media manager sets the player up with", () => {
        expect(mediaManagerSource).toContain("TrackPlayer.setupPlayer(playerSetupOptions(Platform.OS))");
        expect(mediaManagerSource).not.toMatch(/TrackPlayer\.setupPlayer\(\s*\)/);
    });
});
