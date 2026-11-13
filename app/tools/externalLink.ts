import { Linking } from "react-native";
import { log } from "./log";

/**
 * Opens a web page outside the app: the browser on Android and iOS, a new tab on web, and the system browser on desktop
 * (Electron's main process sends every new-window request there, see desktop/main.js). Only http(s) pages; a failure is
 * logged, never thrown, since the caller has nothing better to do with it.
 */
export async function openExternalUrl(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) {
        log.warn("link", `Refused to open a non-web link: ${url}`);
        return;
    }
    try {
        await Linking.openURL(url);
    } catch (error) {
        log.warn("link", `Opening ${url} failed.`, error);
    }
}
