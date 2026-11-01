import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import { ApiStatusFailureError, describeAuthFailure, isUnreachableStatus, statusOfFailure } from "@/app/services/api/errors";
import { SongFilters, SongFilterType } from "@/app/types/SongFilters";

// ShuffullApp#24: the app tells "the server can't be reached" (play downloads only) from "the server answered"
// (an error, or a 401 that logs out).
describe("isUnreachableStatus", () => {
    it("counts no answer and gateway errors as unreachable", () => {
        // What statusOfFailure makes of a call that got no answer at all (offline, DNS, timeout).
        const noAnswer = statusOfFailure(new AxiosError("Network Error", "ERR_NETWORK"));
        expect(isUnreachableStatus(noAnswer)).toBe(true);

        for (const status of [502, 503, 504, 520, 522, 523, 530]) {
            expect(isUnreachableStatus(status), `${status}`).toBe(true);
        }
    });

    it("counts any answer from the API as reachable, a 401 and a plain 500 included", () => {
        for (const status of [200, 400, 401, 403, 404, 409, 500, 501]) {
            expect(isUnreachableStatus(status), `${status}`).toBe(false);
        }
    });
});

describe("describeAuthFailure", () => {
    const host = "https://shuffull-api.clausius.app";

    it("says the server can't be reached when nothing answered", () => {
        expect(describeAuthFailure(new AxiosError("Network Error", "ERR_NETWORK"), host))
            .toBe(`Can't reach the server at ${host}. Check the address and your connection.`);
        expect(describeAuthFailure(new ApiStatusFailureError("/api/v1/users/authenticate", { status: 530 }), host))
            .toContain("Can't reach the server");
    });

    it("passes the server's own reason through, and falls back to the status", () => {
        const wrongPassword = new ApiStatusFailureError("/api/v1/users/authenticate", { status: 400, data: { error: "Username/password is incorrect." } });
        expect(describeAuthFailure(wrongPassword, host)).toBe("Username/password is incorrect.");
        expect(describeAuthFailure(new ApiStatusFailureError("/api/v1/users", { status: 409 }), host)).toBe("The server answered 409.");
    });
});

describe("SongFilters.withLocalOnly", () => {
    it("narrows a copy of the scope to downloads and leaves the saved scope alone", () => {
        const scope = new SongFilters();
        scope.setSoleFilter(SongFilterType.Playlist, ["playlist-1"]);

        const offline = scope.withLocalOnly();

        expect(offline).toBeInstanceOf(SongFilters);
        expect(offline.localOnly).toBe(true);
        expect(offline.whitelists.playlistIds).toEqual(["playlist-1"]);
        expect(scope.localOnly).toBe(false);
    });

    it("turns the whole library into a pool of its downloads", () => {
        const library = new SongFilters();
        expect(library.hasAnyFilter()).toBe(false);
        expect(library.withLocalOnly().hasAnyFilter()).toBe(true);
    });
});
