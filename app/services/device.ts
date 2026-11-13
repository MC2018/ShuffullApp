import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { AppState, Platform } from "react-native";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { DeviceCheckIn, DeviceEnvironment, DeviceIdentity } from "../tools/device";
import { listenPlatform } from "../tools/listens";
import { log } from "../tools/log";
import { ApiClient } from "./api/ApiClient";
import { desktopShell } from "./desktopShell";

// This install's identity (ShuffullApp#58), wired to the real storage, platform and API. The logic and its tests are
// in tools/device.ts.

function environment(): DeviceEnvironment {
    return {
        os: Platform.OS,
        desktop: desktopShell() != undefined,
        model: Platform.OS === "android" ? Platform.constants.Model : undefined,
        isPad: Platform.OS === "ios" ? Platform.isPad : undefined,
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
    };
}

/** The one place to read this install's id and name. */
export const deviceIdentity = new DeviceIdentity({
    storage: AsyncStorage,
    makeId: randomUUID,
    environment,
    idKey: STORAGE_KEYS.DEVICE_ID,
    nameKey: STORAGE_KEYS.DEVICE_NAME,
});

/** The install id, or null if storage can't be read: a listen is still worth recording without it. */
export async function deviceIdOrNull(): Promise<string | null> {
    try {
        return await deviceIdentity.id();
    } catch (e) {
        log.warn("device", "could not read the device id", e);
        return null;
    }
}

/** The signed-in session's check-in, so a rename in Settings can send the new name at once. */
let activeCheckIn: DeviceCheckIn | undefined;

/**
 * Checks in now (the app started signed in, or someone just logged in) and again whenever the app comes to the
 * foreground, throttled. Call it once per session; the returned function stops it.
 */
export function startDeviceCheckIn(api: ApiClient): () => void {
    const checkIn = new DeviceCheckIn({
        identity: deviceIdentity,
        platform: listenPlatform(Platform.OS, desktopShell() != undefined),
        send: (deviceId, body) => api.deviceCheckIn(deviceId, body),
        onError: (trigger, e) => log.warn("device", `${trigger} check-in failed; the next one will retry`, e),
    });
    activeCheckIn = checkIn;
    void checkIn.checkIn("session");

    const appState = AppState.addEventListener("change", state => {
        if (state === "active") {
            void checkIn.checkIn("foreground");
        }
    });

    return () => {
        appState.remove();
        if (activeCheckIn === checkIn) {
            activeCheckIn = undefined;
        }
    };
}

/** The network is back: retries a check-in that failed offline, throttled like a foreground. */
export function checkInDeviceOnReconnect(): void {
    void activeCheckIn?.checkIn("reconnect");
}

/** Renames this device and, when signed in, tells the server at once. Returns the name now in use. */
export async function renameDevice(name: string): Promise<string> {
    const nameInUse = await deviceIdentity.rename(name);
    void activeCheckIn?.checkIn("rename");
    return nameInUse;
}
