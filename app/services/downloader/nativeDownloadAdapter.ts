import * as FileSystem from "expo-file-system/legacy";
import { addNetworkStateListener, getNetworkStateAsync, NetworkState } from "expo-network";
import { AppState } from "react-native";
import path from "path-browserify";
import { verifyFileIntegrity } from "../../tools/utils";
import { isDownloadNetwork, NetworkSnapshot } from "../../tools/downloadStatus";
import { MediaKind } from "../../tools/desktopMedia";
import { foregroundService } from "../background/foregroundService";
import { ensureNotificationPermission } from "../background/notificationPermission";
import { DownloadAdapter } from "./DownloadQueueRunner";
import { log } from "../../tools/log";

if (FileSystem.documentDirectory == null) {
    throw new Error("documentDirectory is null");
}

const tempFolder = path.join(FileSystem.documentDirectory, "temp");
export const musicFolder = path.join(FileSystem.documentDirectory, "music");
export const albumArtFolder = path.join(FileSystem.documentDirectory, "albumart");

const folderFor = (kind: MediaKind) => kind === "music" ? musicFolder : albumArtFolder;

export async function fileExists(uri: string): Promise<boolean> {
    const fileInfo = await FileSystem.getInfoAsync(uri);
    return fileInfo.exists;
}

/**
 * The phone's side of the download loop: files under documentDirectory, downloads only over an allowlisted network
 * (Wi-Fi / Ethernet, see tools/downloadStatus.ts), and the shared foreground service to stay alive in the background.
 */
export function createNativeDownloadAdapter(): DownloadAdapter {
    // Last network state seen, from the listener (instant) or the gate (each attempt). Only used to publish the
    // phase - the gate itself always re-reads before a download starts.
    let network: NetworkState | undefined;
    const snapshot = (state: NetworkState): NetworkSnapshot => ({ isInternetReachable: state.isInternetReachable === true, type: state.type });

    return {
        wifiOnly: true,

        exists: (kind, fileName) => fileExists(path.join(folderFor(kind), fileName)),

        async download(host, kind, fileName, verify, onProgress) {
            const tempPath = path.join(tempFolder, fileName);
            try {
                const result = await FileSystem.createDownloadResumable(
                    path.join(host, kind, fileName),
                    tempPath,
                    {},
                    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
                        if (totalBytesExpectedToWrite > 0) {
                            onProgress(totalBytesWritten / totalBytesExpectedToWrite);
                        }
                    },
                ).downloadAsync();
                // Resolves on ANY HTTP status (a 404 writes the error body to disk), so the status has to be read.
                // Only a 2xx body is the file; art isn't hash-checked, so anything else must never be moved in.
                if (result == undefined || result.status < 200 || result.status >= 300) {
                    return result && { status: result.status };
                }
                // No point hashing an error page, hence after the status check.
                const hashMatches = verify ? await verifyFileIntegrity(result.uri) : undefined;
                if (!verify || hashMatches) {
                    await FileSystem.moveAsync({ from: tempPath, to: path.join(folderFor(kind), fileName) });
                }
                return { status: result.status, hashMatches };
            } finally {
                // Whatever didn't get moved into place - an error body, a partial file, a bad hash - goes, so nothing
                // half-written is left behind. A no-op once the file was moved.
                await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch((e) => log.warn("downloader", "failed to clean up", tempPath, e));
            }
        },

        // Re-read rather than trust the listener: this is the gate that spends the user's data.
        // Allowlist (Wi-Fi / Ethernet), not "anything but cellular" - see tools/downloadStatus.ts.
        async canDownloadNow() {
            network = await getNetworkStateAsync();
            return network.isInternetReachable === true && isDownloadNetwork(network.type);
        },

        async network() {
            network ??= await getNetworkStateAsync();
            return snapshot(network);
        },

        listSongFiles: () => FileSystem.readDirectoryAsync(musicFolder),

        async prepare() {
            await FileSystem.makeDirectoryAsync(tempFolder, { intermediates: true });
            await FileSystem.makeDirectoryAsync(musicFolder, { intermediates: true });
            await FileSystem.makeDirectoryAsync(albumArtFolder, { intermediates: true });
        },

        watch(onChange) {
            addNetworkStateListener((state) => {
                network = state;
                onChange();
            });
            // Coming back to the app is the one moment a stopped service can be restarted (Android 12+ refuses
            // starts from the background), so make sure the loop is running if there is work.
            AppState.addEventListener("change", (state) => {
                if (state === "active") {
                    onChange();
                }
            });
        },

        background: {
            hold: (notification) => foregroundService.hold("downloads", notification),
            release: () => foregroundService.release("downloads"),
            isHeld: () => foregroundService.isHeld("downloads"),
            // User actions are where the notification prompt makes sense (see notificationPermission.ts).
            prepareForUserWork: async () => { await ensureNotificationPermission(); },
        },
    };
}
