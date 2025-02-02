import { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import * as DbQueries from "../services/db/queries";
import * as FileSystem from "expo-file-system";
import { verifyFileIntegrity } from "./utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import { getNetworkStateAsync, NetworkStateType } from "expo-network";

const tempFolder = FileSystem.documentDirectory + "temp/";
const destFolder = FileSystem.documentDirectory + "music/";
let downloading = false;
let paused = true;
let db: ExpoSQLiteDatabase;
let timerId: NodeJS.Timeout;

export async function setup(activeDb: ExpoSQLiteDatabase) {
    db = activeDb;
    // TODO: make it so downloadNext is called less often, and continues downloading next on its own
    timerId = setInterval(async () => {
        if (!downloading && !paused) {
            await downloadNext();
        }
    }, 2000);
    paused = false;
}

// TODO: improve
export function reset() {
    paused = true;

    while (downloading) {

    }
}

export async function addSongToDownloadQueue(songId: number, priority: DownloadPriority) {
    await DbQueries.addToDownloadQueue(db, [songId], priority);
}

// TODO: this could be optimized to prevent spam-presses
export async function addPlaylistToDownloadQueue(playlistId: number, priority: DownloadPriority) {
    let songs = await DbQueries.getSongsByPlaylist(db, playlistId);
    let existingSongs: number[] = [];

    for (let i = 0; i < songs.length; i++) {
        if (await songFileExists(songs[i].directory)) {
            existingSongs.push(songs[i].songId);
        }
    }

    songs = songs.filter(x => !existingSongs.includes(x.songId));
    await DbQueries.addToDownloadQueue(db, songs.map(x => x.songId), priority);
}

export async function songFileExists(fileName: string) {
    const fileInfo = await FileSystem.getInfoAsync(generateLocalSongUri(fileName));
    return fileInfo.exists;
}

export function generateLocalSongUri(fileName: string) {
    return `${destFolder}${fileName}`;
}

async function downloadNext() {
    const nextDownload = await DbQueries.getFromDownloadQueue(db);

    if (!nextDownload) {
        return;
    }

    const song = await DbQueries.getSong(db, nextDownload.songId);

    if (!song) {
        await DbQueries.removeFromDownloadQueue(db, nextDownload.songId);
        return;
    }

    const networkState = await getNetworkStateAsync();

    if (!networkState.isInternetReachable || networkState.type == NetworkStateType.CELLULAR) {
        return;
    }

    if (downloading || paused) {
        return;
    }

    try {
        downloading = true;
        const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);

        if (hostAddress == null) {
            return;
        }

        const downloadResumable = FileSystem.createDownloadResumable(
            `${hostAddress}/music/${song.directory}`,
            `${tempFolder}${song.directory}`);

        if (await songFileExists(song.directory)) {
            await DbQueries.removeFromDownloadQueue(db, song.songId);
            return;
        }

        // Ensure directories exist
        await FileSystem.makeDirectoryAsync(tempFolder, { intermediates: true });
        await FileSystem.makeDirectoryAsync(destFolder, { intermediates: true });

        const downloadedFile = await downloadResumable.downloadAsync();

        if (downloadedFile == undefined) {
            return;
        }

        const verified = await verifyFileIntegrity(downloadedFile.uri)

        if (!verified) {
            return;
        }

        await FileSystem.moveAsync({
            from: downloadedFile.uri,
            to: destFolder + song.directory
        });
        await DbQueries.removeFromDownloadQueue(db, song.songId);
    } catch (e) {
        console.error(e);
    } finally {
        downloading = false;
    }
}

export enum DownloadPriority {
    Low = 1,
    Medium = 2,
    High = 3
}
