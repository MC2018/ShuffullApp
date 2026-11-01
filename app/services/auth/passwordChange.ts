import { HttpStatusCode } from "axios";
import { ApiClient } from "../api/ApiClient";
import { ApiStatusFailureError, describeAuthFailure } from "../api/errors";
import { AuthenticateResponse } from "../api/models";
import { useAuthStore } from "./authStore";

// The parts of a password change that need no native module, so tests can run them: checking the form, building the
// request, explaining a failure, and keeping a stale 401 from logging this device out. auth.ts wires them to the
// hasher, the local DB and the session.

export interface PasswordChangeForm {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
}

/** What is wrong with the form, or null when it can be sent. Checked before any hashing or network call. */
export function validatePasswordChange({ currentPassword, newPassword, confirmPassword }: PasswordChangeForm): string | null {
    if (!currentPassword) {
        return "Enter your current password.";
    }
    if (!newPassword) {
        return "Enter a new password.";
    }
    if (newPassword !== confirmPassword) {
        return "The new passwords don't match.";
    }
    if (newPassword === currentPassword) {
        return "The new password is the same as the current one.";
    }
    return null;
}

/**
 * Hashes both passwords the way login does (argon2 of "username;password"), sends them, and hands the new session to
 * `storeSession`. The username has to be the one the account was created with: the server stored the hash of exactly
 * that string.
 */
export async function sendPasswordChange(
    api: ApiClient,
    hash: (input: string) => Promise<string>,
    storeSession: (session: AuthenticateResponse) => Promise<void>,
    username: string,
    currentPassword: string,
    newPassword: string,
): Promise<void> {
    const currentUserHash = await hash(`${username};${currentPassword}`);
    const newUserHash = await hash(`${username};${newPassword}`);
    // Storing the session is inside the guard too: a 401 that waited on it must find the new client in place.
    await whileChangingCredentials(async () => storeSession(await api.userChangePassword(currentUserHash, newUserHash)));
}

/** What the change-password screen says when the change fails. */
export function describePasswordChangeFailure(error: unknown, hostAddress: string): string {
    // An API from before Shuffull#107 has no such route, and its 404 has no body. A 404 the handler sent ("User not
    // found.") explains itself.
    if (error instanceof ApiStatusFailureError && error.status == HttpStatusCode.NotFound && !error.data) {
        return "This server can't change passwords yet.";
    }

    // A wrong current password is a 400 whose { error } says so ("Current password is incorrect.").
    return describeAuthFailure(error, hostAddress);
}

// A password change replaces this device's token. The server revokes the old one as soon as the change commits, so a
// sync already in flight with it comes back 401, and SyncManager logs out on a 401. Without this, changing the
// password could sign out the very device that changed it.
let credentialChange: Promise<unknown> | null = null;

/** Runs `change` (the request and storing its new session) as the one credential change in flight. */
export async function whileChangingCredentials<T>(change: () => Promise<T>): Promise<T> {
    const run = change();
    credentialChange = run;
    try {
        return await run;
    } finally {
        if (credentialChange === run) {
            credentialChange = null;
        }
    }
}

/**
 * Logs out over a 401 that `client` got, unless that client's session has been replaced since. A 401 that arrives
 * while a password change is in flight waits for it: if the change went through, the session is new and the 401
 * was about the old token; if it failed, the 401 stands.
 */
export async function logoutUnlessReplaced(client: ApiClient, logout: () => Promise<void>): Promise<void> {
    await credentialChange?.catch(() => undefined);

    if (useAuthStore.getState().apiClient !== client) {
        console.log("[auth] Ignoring a 401 on a replaced session's token.");
        return;
    }

    await logout();
}
