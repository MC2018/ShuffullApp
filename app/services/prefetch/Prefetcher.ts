import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getNetworkStateAsync } from "expo-network";
import path from "path-browserify";
import { STORAGE_KEYS } from "../../constants/storageKeys";
import { Song } from "../db/models";
import { Downloader } from "../downloader/Downloader";
import { verifyFileIntegrity } from "../../tools/utils";
import { decideArtDownload } from "../../tools/downloadFailure";
import { PrefetchStore, StorePrefetcher } from "./StorePrefetcher";
import { Prefetcher } from "./types";

/**
 * Native prefetch cache (ShuffullApp#124): the file-system half. `StorePrefetcher` decides what to fetch and drop;
 * this only moves files, so the phone and the desktop (ShuffullApp#137) share one tested set of rules.
 *
 * Kept apart from Downloads on purpose. The files live under the OS cache directory, not the music folder, so
 * `Downloader.fileExists` never sees them, nothing is written to the downloaded-songs table, and no list or count
 * includes them. The folder is emptied at launch, because the index that vouches for its files is in memory only.
 */
function nativePrefetchStore(cacheDirectory: string): PrefetchStore {
    const folder = path.join(cacheDirectory, "prefetch");
    const tempFolder = path.join(folder, "temp");
    const audioUri = (song: Song) => path.join(folder, Downloader.generateSongFileName(song));
    const artUri = (song: Song) => path.join(folder, Downloader.generateAlbumArtFileName(song));

    return {
        async clear() {
            await FileSystem.deleteAsync(folder, { idempotent: true });
            await FileSystem.makeDirectoryAsync(tempFolder, { intermediates: true });
        },
        async canFetch() {
            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
            const network = await getNetworkStateAsync();
            // Any connection will do, mobile data included (decided 2026-10-27); the setting is the off switch.
            return hostAddress != null && network.isInternetReachable !== false;
        },
        isDownloaded: song => Downloader.fileExists(Downloader.generateLocalSongUri(song)),
        async fetch(song, signal) {
            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

            if (hostAddress == null) {
                return { error: "no host" };
            }

            if (signal.aborted) {
                return { error: "cancelled" };
            }

            const fileName = Downloader.generateSongFileName(song);
            const artFileName = Downloader.generateAlbumArtFileName(song);
            const tempAudio = path.join(tempFolder, fileName);
            const tempArt = path.join(tempFolder, artFileName);
            let task: FileSystem.DownloadResumable | undefined;
            const onAbort = () => void task?.cancelAsync().catch(() => undefined);
            signal.addEventListener("abort", onAbort);

            try {
                task = FileSystem.createDownloadResumable(path.join(hostAddress, "music", fileName), tempAudio);
                const audio = await task.downloadAsync();

                if (signal.aborted) {
                    return { error: "cancelled" };
                }

                // downloadAsync resolves on any HTTP status, writing the error body as if it were the file.
                if (audio == undefined || audio.status >= 400) {
                    return { error: `returned ${audio?.status ?? "nothing"}` };
                }

                if (!(await verifyFileIntegrity(tempAudio))) {
                    return { error: "hash check failed" };
                }

                if (signal.aborted) {
                    return { error: "cancelled" };
                }

                task = FileSystem.createDownloadResumable(path.join(hostAddress, "albumart", artFileName), tempArt);
                const art = await task.downloadAsync().catch(() => undefined);

                if (signal.aborted) {
                    return { error: "cancelled" };
                }

                const hasArt = decideArtDownload(art) === "keep";
                await FileSystem.moveAsync({ from: tempAudio, to: audioUri(song) });
                if (hasArt) {
                    await FileSystem.moveAsync({ from: tempArt, to: artUri(song) });
                }

                const info = await FileSystem.getInfoAsync(audioUri(song));
                return { bytes: info.exists ? info.size : 0, audioUri: audioUri(song), artUri: hasArt ? artUri(song) : undefined };
            } finally {
                signal.removeEventListener("abort", onAbort);
                await FileSystem.deleteAsync(tempAudio, { idempotent: true }).catch(() => undefined);
                await FileSystem.deleteAsync(tempArt, { idempotent: true }).catch(() => undefined);
            }
        },
        // The OS may clear its cache directory under storage pressure, so the index alone isn't proof.
        exists: song => Downloader.fileExists(audioUri(song)),
        async remove(song) {
            await FileSystem.deleteAsync(audioUri(song), { idempotent: true }).catch(() => undefined);
            await FileSystem.deleteAsync(artUri(song), { idempotent: true }).catch(() => undefined);
        },
    };
}

export const prefetcher: Prefetcher = new StorePrefetcher(nativePrefetchStore(FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ""));
