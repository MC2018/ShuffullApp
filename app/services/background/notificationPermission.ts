import { PermissionsAndroid, Platform } from "react-native";

let requested = false;

/**
 * Android 13+ gates every notification — foreground-service ones included — behind a runtime permission.
 * Without it the service still runs, but its notification is silently dropped, which is how the old
 * "SongProgress" notification managed to never appear on any modern phone. (Track-player's media
 * notification is exempt, being a MediaSession.)
 *
 * Ask at most once per process, and only from a user action (queueing downloads, resuming) so the prompt
 * has context. A refusal changes nothing about the download itself: the loop runs either way, the user
 * just doesn't get the progress card in the shade. Android stops showing the dialog after two refusals,
 * so this never nags.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
    if (Platform.OS !== "android" || Number(Platform.Version) < 33) {
        return true;
    }

    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;

    try {
        if (await PermissionsAndroid.check(permission)) {
            return true;
        }
        if (requested) {
            return false;
        }
        requested = true;
        const result = await PermissionsAndroid.request(permission);
        return result === PermissionsAndroid.RESULTS.GRANTED;
    } catch (e) {
        console.warn("[notifications] permission check failed", e);
        return false;
    }
}
