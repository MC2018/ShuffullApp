import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/app/constants/storageKeys";
import { Hasher } from "@/app/tools";
import { getDb } from "../db/database";
import DbQueries from "../db/queries";
import { localSessionDataTable } from "../db/schema";
import { ApiClient } from "../api/ApiClient";
import { AuthenticateResponse } from "../api/models";
import { MediaManager } from "../media-manager";
import { Downloader } from "../downloader/Downloader";
import { SyncManager } from "../sync-manager/SyncManager";
import { adoptSongCache, claimSongCache } from "./accountSwitch";
import { useAuthStore } from "./authStore";
import { sendPasswordChange } from "./passwordChange";
import { log } from "@/app/tools/log";

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
        MediaManager.clear().catch((e) => log.warn("player", "Clearing the player failed.", e));
        useAuthStore.getState().clearSession();
        return;
    }

    const apiClient = new ApiClient(hostAddress, localSessionData.token);
    await AsyncStorage.setItem(STORAGE_KEYS.CURRENT_USER_ID, localSessionData.userId);
    // A device updated from a build that never recorded whose songs it holds: they are this session's. Genre jams with no
    // account go to whoever the songs are recorded as belonging to, which is this session only when no one is yet.
    await adoptSongCache(getDb(), AsyncStorage, localSessionData.userId, hostAddress)
        .catch((e) => log.warn("auth", "Recording whose songs and jams this device holds failed; the next start tries again.", e));
    useAuthStore.getState().setSession({ userId: localSessionData.userId, apiClient, hostAddress });
}

// Persist the session envelope returned by authenticate/create/password change and flip the store to authenticated.
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

// How long a login waits for the last account's downloads in flight, and its sync, to finish before clearing its
// songs anyway.
const DOWNLOAD_SETTLE_MS = 10_000;
const SYNC_STOP_MS = 10_000;

// Login and register only, before bootstrapSession: the session doesn't exist yet, so no sync starts while another
// account's songs are still in the cache. A password change keeps the same account, and runs while a sync may be live,
// so it never clears. A failure here doesn't stop the login: the library stays mixed, as before this check existed,
// and the next login tries again, since the cache's owner is recorded only once a clear has finished.
async function claimSongCacheForLogin(userId: string, hostAddress: string): Promise<void> {
    try {
        await claimSongCache({
            db: getDb(),
            storage: AsyncStorage,
            stopSync: async () => {
                if (!(await SyncManager.stopAll(SYNC_STOP_MS))) {
                    log.warn("auth", "The last account's sync was still running when its songs were cleared; it was stopped before its next write.");
                }
            },
            stopPlayback: () => MediaManager.clear(),
            settleDownloads: () => Downloader.clearQueueAndSettleShared(DOWNLOAD_SETTLE_MS),
            deleteSongFiles: song => Downloader.deleteLocalSongFiles(song),
        }, userId, hostAddress);
    } catch (e) {
        log.error("auth", "Claiming this device's songs and genre jams for this account failed; the last account's songs stay in the library until the next login.", e);
    }
}

export async function login(username: string, password: string, hostAddress: string): Promise<void> {
    const userHash = await Hasher.argon2Hash(`${username};${password}`);
    const api = new ApiClient(hostAddress, "");
    const authResponse = await api.userAuthenticate(username, userHash);
    await claimSongCacheForLogin(authResponse.user.userId, hostAddress);
    await bootstrapSession(authResponse, hostAddress);
}

export async function register(username: string, password: string, hostAddress: string): Promise<void> {
    const userHash = await Hasher.argon2Hash(`${username};${password}`);
    const api = new ApiClient(hostAddress, "");
    const authResponse = await api.userCreate(username, userHash);
    await claimSongCacheForLogin(authResponse.user.userId, hostAddress);
    await bootstrapSession(authResponse, hostAddress);
}

// Changes the signed-in user's password and keeps this device signed in on the session the server returns. Every
// other device's token stops working, so each logs out on its next sync. Throws on failure (a wrong current password
// is a 400) without touching the session.
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const { userId, apiClient, hostAddress } = useAuthStore.getState();

    if (userId == null || apiClient == null || hostAddress == null) {
        throw Error("Not signed in.");
    }

    // The sync keeps the user row; fall back to asking the server on a device that hasn't synced it yet.
    const username = (await DbQueries.getUser(getDb(), userId))?.username ?? (await apiClient.userGet()).username;
    await sendPasswordChange(apiClient, Hasher.argon2Hash, session => bootstrapSession(session, hostAddress),
        username, currentPassword, newPassword);
}

export async function logout(): Promise<void> {
    await getDb().update(localSessionDataTable).set({
        expiration: new Date(Date.now()),
    });

    MediaManager.clear().catch((e) => log.warn("player", "Clearing the player failed.", e));
    await AsyncStorage.removeItem(STORAGE_KEYS.CURRENT_USER_ID);
    useAuthStore.getState().clearSession();
}
