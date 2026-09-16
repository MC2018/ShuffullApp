import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { Hasher } from "@/app/tools";
import { getDb } from "../db/database";
import DbQueries from "../db/queries";
import { localSessionDataTable } from "../db/schema";
import { ApiClient } from "../api/ApiClient";
import { AuthenticateResponse } from "../api/models";
import { MediaManager } from "../media-manager";
import { useAuthStore } from "./authStore";

// Imperative auth service. All session transitions funnel through here and end by mutating the auth
// store, which the route guards observe. Pulling this out of a React component (the old index.tsx /
// LogoutProvider) means login/logout can be triggered from anywhere (buttons, the expiry watcher,
// the sync manager) without prop drilling.

// Attempt to restore a previously persisted session on app start. Always resolves the auth status to
// either "authenticated" or "unauthenticated" so the loading gate can clear.
export async function restoreSession(): Promise<void> {
    const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
    const localSessionData = await DbQueries.getActiveLocalSessionData(getDb());

    if (!localSessionData || !hostAddress) {
        MediaManager.clear();
        useAuthStore.getState().clearSession();
        return;
    }

    const apiClient = new ApiClient(hostAddress, localSessionData.token);
    await AsyncStorage.setItem(STORAGE_KEYS.CURRENT_USER_ID, localSessionData.userId);
    useAuthStore.getState().setSession({ userId: localSessionData.userId, apiClient, hostAddress });
}

// Persist the session envelope returned by authenticate/create and flip the store to authenticated.
async function bootstrapSession(authResponse: AuthenticateResponse, hostAddress: string): Promise<void> {
    const db = getDb();

    await db.insert(localSessionDataTable).values([{
        userId: authResponse.user.userId,
        activelyDownload: false,
        token: authResponse.token,
        expiration: new Date(authResponse.expiration),
    }]).onConflictDoUpdate({
        target: localSessionDataTable.userId,
        set: {
            token: authResponse.token,
            expiration: new Date(authResponse.expiration),
        },
    });

    const localSessionData = await DbQueries.getLocalSessionData(db, authResponse.user.userId);

    if (!localSessionData) {
        throw Error("Critical error: Local session data cannot find data after upserting.");
    }

    await AsyncStorage.setItem(STORAGE_KEYS.CURRENT_USER_ID, localSessionData.userId);
    const apiClient = new ApiClient(hostAddress, authResponse.token);
    useAuthStore.getState().setSession({ userId: localSessionData.userId, apiClient, hostAddress });
}

export async function login(username: string, password: string, hostAddress: string): Promise<void> {
    const userHash = await Hasher.argon2Hash(`${username};${password}`);
    const api = new ApiClient(hostAddress, "");
    const authResponse = await api.userAuthenticate(username, userHash);
    await bootstrapSession(authResponse, hostAddress);
}

export async function register(username: string, password: string, hostAddress: string): Promise<void> {
    const userHash = await Hasher.argon2Hash(`${username};${password}`);
    const api = new ApiClient(hostAddress, "");
    const authResponse = await api.userCreate(username, userHash);
    await bootstrapSession(authResponse, hostAddress);
}

export async function logout(): Promise<void> {
    await getDb().update(localSessionDataTable).set({
        expiration: new Date(Date.now()),
    });

    MediaManager.clear();
    await AsyncStorage.removeItem(STORAGE_KEYS.CURRENT_USER_ID);
    useAuthStore.getState().clearSession();
}
