import { afterEach, describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";
import { ApiClient } from "@/app/services/api/ApiClient";
import { ApiStatusFailureError } from "@/app/services/api/errors";
import { AuthenticateResponse } from "@/app/services/api/models";
import { useAuthStore } from "@/app/services/auth/authStore";
import {
    describePasswordChangeFailure,
    logoutUnlessReplaced,
    sendPasswordChange,
    validatePasswordChange,
} from "@/app/services/auth/passwordChange";

// The change-password screen (ShuffullApp#158). The submit path runs against a stand-in API: the real endpoint revokes
// every other session of the account, so nothing here may reach a real server.

const session: AuthenticateResponse = {
    user: { userId: "user-1", username: "listener", version: new Date(0), isCurator: false },
    token: "new-token",
    expiration: new Date(0),
};

/** A stand-in hasher that shows what it was given. */
const hash = async (input: string) => `hash(${input})`;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** A client whose userChangePassword answers with `answer`, recording what it was sent. */
function stubApi(answer: () => Promise<AuthenticateResponse>) {
    const sent: [string, string][] = [];
    const api = new ApiClient("http://api", "old-token");
    api.userChangePassword = async (currentUserHash, newUserHash) => {
        sent.push([currentUserHash, newUserHash]);
        return answer();
    };
    return { api, sent };
}

function signIn(api: ApiClient) {
    useAuthStore.getState().setSession({ userId: "user-1", apiClient: api, hostAddress: "http://api" });
}

const wrongPassword = () => new ApiStatusFailureError("/api/v1/users/me/password", {
    status: 400,
    data: { error: "Current password is incorrect." },
});

afterEach(() => useAuthStore.getState().clearSession());

describe("validatePasswordChange", () => {
    const form = { currentPassword: "old", newPassword: "new", confirmPassword: "new" };

    it("accepts a filled-in form whose new passwords match", () => {
        expect(validatePasswordChange(form)).toBeNull();
    });

    it.each([
        [{ currentPassword: "" }, "Enter your current password."],
        [{ newPassword: "", confirmPassword: "" }, "Enter a new password."],
        [{ confirmPassword: "nwe" }, "The new passwords don't match."],
        [{ newPassword: "old", confirmPassword: "old" }, "The new password is the same as the current one."],
    ])("refuses %o", (change, message) => {
        expect(validatePasswordChange({ ...form, ...change })).toBe(message);
    });
});

describe("sendPasswordChange", () => {
    it("sends the login hash of username;password for both, and stores the session it gets back", async () => {
        const { api, sent } = stubApi(async () => session);
        const storeSession = vi.fn(async () => {});

        await sendPasswordChange(api, hash, storeSession, "listener", "old pass", "new pass");

        expect(sent).toEqual([["hash(listener;old pass)", "hash(listener;new pass)"]]);
        expect(storeSession).toHaveBeenCalledExactlyOnceWith(session);
    });

    it("stores nothing and shows the server's message when the current password is wrong", async () => {
        const { api } = stubApi(async () => { throw wrongPassword(); });
        const storeSession = vi.fn(async () => {});

        const error = await sendPasswordChange(api, hash, storeSession, "listener", "typo", "new").catch(e => e);

        expect(storeSession).not.toHaveBeenCalled();
        expect(describePasswordChangeFailure(error, "http://api")).toBe("Current password is incorrect.");
    });
});

describe("describePasswordChangeFailure", () => {
    it("says so when the server has no change-password endpoint", () => {
        const error = new ApiStatusFailureError("/api/v1/users/me/password", { status: 404, data: "" });
        expect(describePasswordChangeFailure(error, "http://api")).toBe("This server can't change passwords yet.");
    });

    it("passes on a 404 the endpoint explained", () => {
        const error = new ApiStatusFailureError("/api/v1/users/me/password", { status: 404, data: { error: "User not found." } });
        expect(describePasswordChangeFailure(error, "http://api")).toBe("User not found.");
    });

    it("says the server can't be reached when there is no answer", () => {
        const error = new AxiosError("Network Error", AxiosError.ERR_NETWORK);
        expect(describePasswordChangeFailure(error, "http://api")).toContain("Can't reach the server at http://api");
    });
});

describe("logoutUnlessReplaced: a 401 on the old token doesn't sign out the device that changed the password", () => {
    it("logs out over a 401 when no password change is involved", async () => {
        const api = new ApiClient("http://api", "token");
        signIn(api);
        const logout = vi.fn(async () => {});

        await logoutUnlessReplaced(api, logout);

        expect(logout).toHaveBeenCalledOnce();
    });

    it("ignores a 401 that arrives while the change is in flight, once the change replaces the session", async () => {
        const answer = deferred<AuthenticateResponse>();
        const { api: oldApi, sent } = stubApi(() => answer.promise);
        signIn(oldApi);
        const newApi = new ApiClient("http://api", session.token);
        const logout = vi.fn(async () => {});

        const change = sendPasswordChange(oldApi, hash, async () => signIn(newApi), "listener", "old", "new");
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        // The server has committed the change; a sync still holding the old token gets its 401 now.
        const staleLogout = logoutUnlessReplaced(oldApi, logout);
        answer.resolve(session);
        await Promise.all([change, staleLogout]);

        expect(useAuthStore.getState().apiClient).toBe(newApi);
        expect(logout).not.toHaveBeenCalled();
    });

    it("ignores a 401 on the old token after the session was replaced", async () => {
        const oldApi = new ApiClient("http://api", "old-token");
        signIn(new ApiClient("http://api", "new-token"));
        const logout = vi.fn(async () => {});

        await logoutUnlessReplaced(oldApi, logout);

        expect(logout).not.toHaveBeenCalled();
    });

    it("still logs out over a 401 that waited on a change that failed", async () => {
        const answer = deferred<AuthenticateResponse>();
        const { api, sent } = stubApi(() => answer.promise);
        signIn(api);
        const logout = vi.fn(async () => {});

        const change = sendPasswordChange(api, hash, async () => {}, "listener", "typo", "new").catch(e => e);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        const revoked = logoutUnlessReplaced(api, logout);
        answer.reject(wrongPassword());
        await Promise.all([change, revoked]);

        expect(logout).toHaveBeenCalledOnce();
    });
});
